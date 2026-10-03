import fs, { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import consola from 'consola'
import path from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli/index.js'
import { loadMatrixConfig } from '../../src/config/index.js'
import { createExecutionPlan } from '../../src/execution/plan.js'
import { findTypeHost } from '../../src/typegen/prepare.js'

const previousCwd = process.cwd()
const directories: string[] = []
const plugin = fileURLToPath(new URL('../../src/unplugin/vite.ts', import.meta.url))
let messages: string[]

beforeEach(() => {
  messages = []
  vi.spyOn(consola, 'info').mockImplementation((message) => {
    messages.push(String(message))
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.chdir(previousCwd)
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function workspace(config: string, project: { root?: string, configFile?: string } = {}): Promise<string> {
  const cwd = path.normalize(await realpath(await mkdtemp(path.join(os.tmpdir(), 'matrix host types-'))))
  directories.push(cwd)
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(cwd, 'node_modules'), 'junction')
  await writeFile(path.join(cwd, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(cwd, 'matrix.config.mjs'), [
    'export default {',
    '  envSchema: {',
    '    APP_ENABLED: { type: "boolean", default: false },',
    '    APP_REQUIRED: { type: "number" },',
    '    APP_OPTIONAL: { type: "string", optional: true },',
    '    PRIVATE_REQUIRED: { type: "string" },',
    '  },',
    `  projects: { web: ${JSON.stringify({ ...project, targets: { dev: 'node should-not-run.mjs' } })} },`,
    '  products: {',
    '    alpha: { env: { APP_ALPHA: "alpha-private-value" }, variants: { web: "web" } },',
    '    beta: { env: { APP_BETA: "beta-private-value" }, variants: { web: "web" } },',
    '  },',
    '}',
  ].join('\n'))
  const projectRoot = path.resolve(cwd, project.root ?? '.')
  await mkdir(projectRoot, { recursive: true })
  await writeFile(path.join(projectRoot, 'vite.config.mjs'), `import matrix from ${JSON.stringify(plugin)};\n${config}`)
  process.chdir(cwd)
  return cwd
}

async function genericWorkspace(): Promise<string> {
  const cwd = await workspace('export default { plugins: [] };')
  await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default {
    projects: {
      frontend: { root: 'apps/web', targets: { test: 'node should-not-run.mjs' } },
      secondary: { root: 'apps/next', targets: { test: 'node should-not-run.mjs' } },
    },
    products: { app: { variants: { web: 'frontend', next: 'secondary' } } },
  }`)
  for (const root of ['web', 'next'])
    await mkdir(path.join(cwd, 'apps', root), { recursive: true })
  return cwd
}

describe('host-aware type preparation', () => {
  it.each([
    ['readdir', 'SIGINT', 130],
    ['writeFile', 'SIGTERM', 143],
  ] as const)('cancels during generic %s without overwriting declarations or starting later projects', async (boundary, signal, exitCode) => {
    const previousExitCode = process.exitCode
    const listeners = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') }
    const cwd = await genericWorkspace()
    const root = path.join(cwd, 'apps/web')
    const output = path.join(root, '.matrix/types/matrix-runtime.d.ts')
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, '// existing declaration')
    let interrupted = false
    const original = fs[boundary]
    const operation = vi.spyOn(fs, boundary).mockImplementation(async (...args: unknown[]) => {
      const result = await Reflect.apply(original, fs, args)
      const location = path.normalize(String(args[0]))
      const matches = boundary === 'readdir' ? location === root : location.startsWith(`${output}.`)
      if (!interrupted && matches) {
        interrupted = true
        process.emit(signal)
      }
      return result
    })
    syncBuiltinESMExports()
    try {
      await runCli(['prepare', 'app'])
      expect(interrupted).toBe(true)
      expect(process.exitCode).toBe(exitCode)
      const summaries = messages.filter(message => message.startsWith('Execution '))
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toContain(`Execution cancelled (${signal})`)
      expect(summaries[0]).not.toContain('Failure:')
      expect(await readFile(output, 'utf8')).toBe('// existing declaration')
      expect(await fs.readdir(path.dirname(output))).toEqual(['matrix-runtime.d.ts'])
      await expect(access(path.join(cwd, 'apps/next/.matrix'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(process.listenerCount('SIGINT')).toBe(listeners.SIGINT)
      expect(process.listenerCount('SIGTERM')).toBe(listeners.SIGTERM)
    }
    finally {
      operation.mockRestore()
      syncBuiltinESMExports()
      process.exitCode = previousExitCode
    }
  })

  it('identifies the project and affected task for declaration write failures while retaining earlier outputs', async () => {
    const cwd = await genericWorkspace()
    await writeFile(path.join(cwd, 'apps/next/.matrix'), 'output-blocker')
    await expect(runCli(['prepare', 'app'])).rejects.toThrow('preparation, project secondary, affected task app:next:prepare')
    const summaries = messages.filter(message => message.startsWith('Execution '))
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain('Execution failed')
    expect(summaries[0]).toContain('project secondary, affected task app:next:prepare')
    expect(summaries[0]).toMatch(/ENOTDIR|EEXIST|ENOENT/)
    const earlier = path.join(cwd, 'apps/web/.matrix/types/matrix-runtime.d.ts')
    expect(summaries[0]).toContain(`Artifact: ${earlier}`)
    expect(await readFile(earlier, 'utf8')).toContain('Generated by')
  })

  it('summarizes SIGINT cancellation only after the type worker has exited', async () => {
    const previousExitCode = process.exitCode
    const cwd = await workspace([
      'import { writeFileSync } from "node:fs";',
      'export default async () => {',
      '  setInterval(() => {}, 1000);',
      '  writeFileSync("ready.pid", String(process.pid));',
      '  await new Promise(() => {});',
      '};',
    ].join(String.fromCharCode(10)))
    let completed = false
    const running = runCli(['prepare', 'alpha']).finally(() => {
      completed = true
    })
    void running.catch(() => undefined)
    try {
      let pid = 0
      await vi.waitFor(async () => {
        pid = Number(await readFile(path.join(cwd, 'ready.pid'), 'utf8'))
        expect(pid).toBeGreaterThan(0)
      }, { timeout: 2000 })
      process.emit('SIGINT')
      await running
      expect(process.exitCode).toBe(130)
      expect(() => process.kill(pid, 0)).toThrow()
      const summaries = messages.filter(message => message.startsWith('Execution '))
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toContain('Execution cancelled (SIGINT)')
      expect(summaries[0]).not.toContain('Failure:')
      await expect(access(path.join(cwd, '.matrix/types/matrix-runtime.d.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    finally {
      if (!completed)
        process.emit('SIGINT')
      await running
      process.exitCode = previousExitCode
    }
  })

  it('preserves generic declarations when a project adds Vite without the Matrix plugin', async () => {
    const cwd = await workspace('export default { plugins: [] };')
    await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default ${JSON.stringify({
      envSchema: {
        VITE_ENABLED: { type: 'boolean', default: false },
        VITE_OPTIONAL: { type: 'string', optional: true },
        PRIVATE_REQUIRED: { type: 'string' },
      },
      projects: { web: { targets: { dev: 'node should-not-run.mjs' } } },
      products: {
        alpha: { env: { VITE_ALPHA: 'alpha-private-value' }, variants: { web: 'web' } },
        beta: { env: { VITE_BETA: 'beta-private-value' }, variants: { web: 'web' } },
      },
    })}`)
    const configFile = path.join(cwd, 'vite.config.mjs')
    await rename(configFile, path.join(cwd, 'saved-config.mjs'))
    await runCli(['prepare'])
    const output = path.join(cwd, '.matrix/types/matrix-runtime.d.ts')
    const generic = await readFile(output, 'utf8')
    for (const field of ['alpha: string', 'beta: string', 'enabled: boolean', 'optional?: string'])
      expect(generic).toContain(`readonly ${field}`)
    expect(generic).toContain('readonly VITE_ENABLED: string')
    expect(generic).not.toMatch(/private-value|PRIVATE_REQUIRED/)
    await rm(output)
    await rename(path.join(cwd, 'saved-config.mjs'), configFile)
    await runCli(['prepare'])
    expect(await readFile(output, 'utf8')).toBe(generic)
  })

  it.each([
    [{ MATRIX_PRODUCT_VERSION: '4.0.0' }, '3.0.0', '2.0.0', '4.0.0'],
    [{}, undefined, undefined, '1.0.0'],
  ])('prepares with execution-plan identity and version precedence (%j, %s, %s)', async (env, variantVersion, productVersion, version) => {
    const cwd = await workspace([
      'import { readFileSync } from "node:fs";',
      'const expected = JSON.parse(readFileSync("expected.json", "utf8"));',
      'for (const [key, value] of Object.entries(expected)) {',
      '  if (process.env[key] !== String(value)) throw new Error("Incorrect context: " + key);',
      '}',
      'export default { plugins: [matrix()] };',
    ].join('\n'))
    const config = {
      env: { ...env, MATRIX_PRODUCT_NAME: 'Override' },
      suffixes: { staging: { name: ' Global', slug: '-global', appId: '.global' } },
      projects: { web: { targets: { dev: 'node should-not-run.mjs' } } },
      products: {
        app: {
          id: 'example',
          name: 'Product',
          slug: 'product',
          appId: 'dev.product',
          version: productVersion,
          suffixes: { staging: { slug: '-product' } },
          variants: { web: { project: 'web', name: 'Variant', appId: 'dev.variant', version: variantVersion, suffixes: { staging: { appId: '.variant' } } } },
        },
      },
    }
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.0' }))
    await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default ${JSON.stringify(config)}`)
    const loaded = await loadMatrixConfig({ envName: 'staging' })
    const task = createExecutionPlan({ ...loaded, productNames: ['app'], target: 'dev' }).tasks[0]!
    expect(task.env).toMatchObject({
      MATRIX_PRODUCT_ID: 'example',
      MATRIX_PRODUCT_NAME: 'Override Global',
      MATRIX_PRODUCT_SLUG: 'product-product',
      MATRIX_PRODUCT_APP_ID: 'dev.variant.variant',
      MATRIX_PRODUCT_VERSION: version,
    })
    const expected = Object.fromEntries(Object.entries(task.env).filter(([key]) => key.startsWith('MATRIX_') || key === 'NODE_ENV'))
    await writeFile(path.join(cwd, 'expected.json'), JSON.stringify({ ...expected, MATRIX_TARGET: 'prepare', MATRIX_NODE_ENV: 'development', NODE_ENV: 'development' }))
    await runCli(['prepare', '--env', 'staging'])
    expect(await readFile(path.join(cwd, '.matrix/types/matrix-runtime.d.ts'), 'utf8')).toContain('declare module \'virtual:matrix/runtime\'')
  })

  it('resolves real Vite config without serving or building and unions product keys without requiring values', async () => {
    const cwd = await workspace([
      'import { scope } from "./settings.mjs";',
      'export default async ({ command, mode }) => {',
      '  if (command !== "serve" || mode !== "staging") throw new Error("Wrong preparation context");',
      '  if (process.env.MATRIX_TARGET !== "prepare" || process.env.MATRIX_VARIANT !== "web") throw new Error("Missing Matrix context");',
      '  if (process.env.MATRIX_PREPARE_LEAK) throw new Error("Config process was reused");',
      '  process.env.MATRIX_PREPARE_LEAK = "local";',
      '  setInterval(() => {}, 1000);',
      '  return {',
      '    root: "app",',
      '    envDir: "environment",',
      '    plugins: [',
      '      { name: "host-prefix", config() { return { envPrefix: ["APP_"] }; }, buildStart() { throw new Error("Must not build"); }, configureServer() { throw new Error("Must not serve"); } },',
      '      matrix({ scope, types: { output: ".matrix/types/custom.d.ts" } }),',
      '    ],',
      '  };',
      '};',
    ].join('\n'))
    await writeFile(path.join(cwd, 'settings.mjs'), 'export const scope = "web";')
    await mkdir(path.join(cwd, 'app/environment'), { recursive: true })
    await writeFile(path.join(cwd, 'app/environment/.env.staging'), 'APP_LOCAL=local-private-value\nOTHER_HIDDEN=hidden-value\n')

    await runCli(['prepare', '--env', 'staging'])

    const declaration = await readFile(path.join(cwd, 'app/.matrix/types/custom.d.ts'), 'utf8')
    expect(declaration).toContain('declare module \'virtual:matrix/runtime/web\'')
    for (const field of ['alpha: string', 'beta: string', 'local: string', 'enabled: boolean', 'required: number', 'optional?: string'])
      expect(declaration).toContain(`readonly ${field}`)
    expect(declaration).not.toMatch(/private-value|hidden-value|OTHER_HIDDEN|PRIVATE_REQUIRED|MATRIX_PREPARE_LEAK/)
    expect(process.env.MATRIX_PREPARE_LEAK).toBeUndefined()
    await expect(access(path.join(cwd, '.matrix/types/matrix-runtime.d.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(path.join(cwd, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['duplicate scope', 'export default { plugins: [matrix({ scope: "shared" }), matrix({ scope: "shared" })] };', 'Duplicate Matrix scope', ['types/matrix-runtime-shared.d.ts']],
    ['shared output', 'export default { plugins: [matrix({ scope: "main", types: { output: ".matrix/same.d.ts" } }), matrix({ scope: "preload", types: { output: ".matrix/same.d.ts" } })] };', 'Conflicting Matrix type contracts', ['same.d.ts']],
    ['product-dependent prefixes', 'export default { envPrefix: process.env.MATRIX_PRODUCT_KEY === "alpha" ? "APP_" : "OTHER_", plugins: [matrix()] };', 'Conflicting Matrix type contracts', ['types/matrix-runtime.d.ts']],
    ['product-dependent scopes', 'export default { plugins: [matrix({ scope: process.env.MATRIX_PRODUCT_KEY })] };', 'Matrix scopes change', ['types/matrix-runtime-alpha.d.ts', 'types/matrix-runtime-beta.d.ts']],
    ['late config failure', 'export default () => { if (process.env.MATRIX_PRODUCT_KEY === "beta") throw new Error("beta config failed"); return { plugins: [matrix()] }; };', 'beta config failed', ['types/matrix-runtime.d.ts']],
  ] as const)('rejects %s before changing existing declarations', async (_name, config, message, outputs) => {
    const cwd = await workspace(config)
    const existing = path.join(cwd, '.matrix', outputs[0])
    await mkdir(path.dirname(existing), { recursive: true })
    await writeFile(existing, '// existing declaration\n')
    await expect(runCli(['prepare'])).rejects.toThrow(message)
    const summaries = messages.filter(message => message.startsWith('Execution '))
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toContain('Execution failed')
    expect(summaries[0]).toContain('prepare:types [preparation')
    if (_name === 'late config failure') {
      expect(summaries[0]).toContain('project web')
      expect(summaries[0]).toContain('affected task beta:web:prepare')
    }
    expect(await readFile(existing, 'utf8')).toBe('// existing declaration\n')
    for (const output of outputs.slice(1))
      await expect(access(path.join(cwd, '.matrix', output))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('merges host roots that refer to the same directory through a filesystem alias', async () => {
    const cwd = await workspace('export default { root: process.env.MATRIX_PRODUCT_KEY === "alpha" ? "app" : "linked-app", envPrefix: "APP_", plugins: [matrix()] };')
    await mkdir(path.join(cwd, 'app'))
    await symlink(path.join(cwd, 'app'), path.join(cwd, 'linked-app'), 'junction')

    await runCli(['prepare'])

    const declaration = await readFile(path.join(cwd, 'app/.matrix/types/matrix-runtime.d.ts'), 'utf8')
    expect(declaration).toContain('readonly alpha: string')
    expect(declaration).toContain('readonly beta: string')
  })

  it('honors types:false instead of falling back to generic declarations', async () => {
    const cwd = await workspace('export default { plugins: [matrix({ types: false })] };')
    await runCli(['prepare'])
    await expect(access(path.join(cwd, '.matrix'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discovers only root files and prefers electron-vite over Vite', async () => {
    const cwd = await workspace('throw new Error("Must not evaluate configs during discovery");')
    const nested = path.join(cwd, 'nested')
    await mkdir(path.join(nested, 'config'), { recursive: true })
    await writeFile(path.join(nested, 'config/electron.vite.config.mjs'), 'throw new Error("Nested configs are not discovered");')
    // Neither the parent Vite config nor a child-directory config belongs to this root.
    expect(await findTypeHost(nested)).toBeUndefined()
    // A directory named like a config is not a config file.
    await mkdir(path.join(cwd, 'electron.vite.config.ts'))
    expect(await findTypeHost(cwd)).toEqual({ name: 'vite', configFile: path.join(cwd, 'vite.config.mjs') })
    await writeFile(path.join(cwd, 'vite.config.ts'), 'throw new Error("Must not load an ambiguous config");')
    await expect(findTypeHost(cwd)).rejects.toThrow('Ambiguous vite configuration')
    await writeFile(path.join(cwd, 'electron.vite.config.mjs'), 'export default {};')
    expect(await findTypeHost(cwd)).toEqual({ name: 'electron-vite', configFile: path.join(cwd, 'electron.vite.config.mjs') })
  })

  it('uses project.configFile relative to project root instead of automatic candidates', async () => {
    const cwd = await workspace('export default { plugins: [matrix({ scope: "selected", envPrefix: "APP_" })] };', {
      root: 'project',
      configFile: 'config/vite.config.mjs',
    })
    const projectRoot = path.join(cwd, 'project')
    await mkdir(path.join(projectRoot, 'config'))
    await rename(path.join(projectRoot, 'vite.config.mjs'), path.join(projectRoot, 'config/vite.config.mjs'))
    for (const file of ['vite.config.mjs', 'electron.vite.config.mjs'])
      await writeFile(path.join(projectRoot, file), 'throw new Error("Explicit config must take precedence");')
    await runCli(['prepare'])
    const declaration = await readFile(path.join(projectRoot, '.matrix/types/matrix-runtime-selected.d.ts'), 'utf8')
    expect(declaration).toContain('readonly alpha: string')
    expect(declaration).toContain('readonly beta: string')
    await expect(access(path.join(cwd, '.matrix'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(path.join(projectRoot, 'config/vite.config.mjs'), 'throw new Error("Selected config failed");')
    await expect(runCli(['prepare'])).rejects.toThrow('Selected config failed')
    expect(await readFile(path.join(projectRoot, '.matrix/types/matrix-runtime-selected.d.ts'), 'utf8')).toBe(declaration)
  })

  it.each([
    ['config/vite.config.mjs', 'ENOENT'],
    ['custom.ts', 'Unsupported host config filename'],
    ['vite.config.ts', 'Host config is not a file'],
  ])('does not fall back from invalid explicit config %s', async (configFile, message) => {
    const cwd = await workspace('export default { plugins: [matrix()] };', { configFile })
    await writeFile(path.join(cwd, 'custom.ts'), 'export default {};')
    await mkdir(path.join(cwd, 'vite.config.ts'))
    await expect(runCli(['prepare'])).rejects.toThrow(message)
    await expect(access(path.join(cwd, '.matrix'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
