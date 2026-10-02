import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli/index.js'
import { loadMatrixConfig } from '../../src/config/index.js'
import { createExecutionPlan } from '../../src/execution/plan.js'
import { findTypeHost } from '../../src/typegen/prepare.js'

const previousCwd = process.cwd()
const directories: string[] = []
const plugin = fileURLToPath(new URL('../../src/unplugin/vite.ts', import.meta.url))

afterEach(async () => {
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

describe('host-aware type preparation', () => {
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
