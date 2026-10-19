import type { MatrixUnpluginOptions } from '../../src/unplugin/index.js'
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import consola from 'consola'
import path from 'pathe'
import { rollup } from 'rollup'
import { build, resolveConfig } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli/index.js'
import { MATRIX_ENV_SCHEMA_KEY, MATRIX_TYPE_CONTRACT_KEY } from '../../src/config/env-schema.js'
import { preparedTypeDeclaration } from '../../src/typegen/coordination.js'
import { generateMatrixTypes } from '../../src/typegen/generate.js'
import { MatrixUnplugin } from '../../src/unplugin/index.js'

const temporaryDirectories: string[] = []
const previousCwd = process.cwd()
const output = '.matrix/types/matrix-runtime.d.ts'
const hosts = ['vite config', 'vite build', 'rollup build'] as const
type Host = typeof hosts[number]

beforeEach(() => {
  // Do not let the separate default Vitest suppression satisfy the guard tests.
  vi.stubEnv('VITEST', undefined)
  vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, undefined)
  vi.stubEnv(MATRIX_TYPE_CONTRACT_KEY, undefined)
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MAIN_VITE_'))
      vi.stubEnv(key, undefined)
  }
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.chdir(previousCwd)
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function projectDirectory(): Promise<string> {
  const project = await mkdtemp(path.join(os.tmpdir(), 'matrix-unplugin-types-'))
  temporaryDirectories.push(project)
  await writeFile(path.join(project, 'entry.js'), 'export const value = 1')
  return project
}

function hostRunner(host: Host, project: string, options?: MatrixUnpluginOptions): () => Promise<void> {
  const envPrefix = ['MAIN_VITE_', 'MATRIX_', '__MATRIX_']
  if (host === 'rollup build') {
    const plugin = MatrixUnplugin.rollup({ envPrefix, ...options })
    return async () => {
      const cwd = process.cwd()
      process.chdir(project)
      try {
        const bundle = await rollup({ input: path.join(project, 'entry.js'), plugins: [plugin] })
        await bundle.close()
      }
      finally {
        process.chdir(cwd)
      }
    }
  }
  const config = {
    root: project,
    configFile: false as const,
    envFile: false as const,
    envPrefix,
    plugins: [MatrixUnplugin.vite(options)],
    logLevel: 'silent' as const,
  }
  return async () => {
    if (host === 'vite config') {
      const resolved = await resolveConfig(config, 'serve')
      expect(resolved.env).not.toHaveProperty(MATRIX_ENV_SCHEMA_KEY)
      expect(resolved.env).not.toHaveProperty(MATRIX_TYPE_CONTRACT_KEY)
    }
    else {
      await build({
        ...config,
        publicDir: false,
        build: {
          write: false,
          lib: { entry: path.join(project, 'entry.js'), formats: ['es'] },
        },
      })
    }
  }
}

describe('matrix unplugin', () => {
  it('consumes a complete coordinated contract without publishing an active-product subset', async () => {
    const project = await projectDirectory()
    const shared = {
      cwd: project,
      env: { MAIN_VITE_ALPHA: '', MAIN_VITE_BETA: '' },
      optionalEnvKeys: ['MAIN_VITE_ALPHA', 'MAIN_VITE_BETA'],
      envPrefix: ['MAIN_VITE_', 'MATRIX_', '__MATRIX_'],
    }
    const filename = await generateMatrixTypes(shared)
    const complete = await readFile(filename, 'utf8')
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, '{}')
    vi.stubEnv(MATRIX_TYPE_CONTRACT_KEY, JSON.stringify({ strict: true, declarations: [preparedTypeDeclaration(shared)] }))
    vi.stubEnv('MAIN_VITE_ALPHA', 'active')
    await hostRunner('vite config', project)()
    expect(await readFile(filename, 'utf8')).toBe(complete)
    expect(complete).not.toContain(MATRIX_TYPE_CONTRACT_KEY)
    vi.stubEnv('MAIN_VITE_UNCOLLECTED', 'unexpected')
    await expect(hostRunner('vite config', project, { types: true })()).rejects.toThrow('Matrix type contract changed after collection')
    expect(await readFile(filename, 'utf8')).toBe(complete)
  })

  it('skips automatic types in Vitest even with Matrix context', async () => {
    vi.stubEnv('VITEST', 'true')
    const project = await projectDirectory()
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, '{}')
    vi.stubEnv('MAIN_VITE_WINDOW_TITLE', 'Matrix')
    const warning = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    await hostRunner('vite config', project)()

    await expect(access(path.join(project, '.matrix'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(warning).not.toHaveBeenCalled()
  })

  it.each(hosts.flatMap(host => [true, false].map(existing => ({ host, existing }))))(
    '$host preserves declarations without Matrix context (existing=$existing)',
    async ({ host, existing }) => {
      vi.stubEnv('MAIN_VITE_WINDOW_TITLE', 'incomplete build context')
      const project = await projectDirectory()
      const filename = path.join(project, output)
      const original = '// existing declaration with fields absent from this build\n'
      if (existing) {
        await mkdir(path.dirname(filename), { recursive: true })
        await writeFile(filename, original)
        await utimes(filename, new Date(0), new Date(0))
      }
      const before = existing ? await stat(filename) : undefined
      const warning = vi.spyOn(consola, 'warn').mockImplementation(() => {})
      const run = hostRunner(host, project)
      await run()
      await run()

      if (before) {
        expect(await readFile(filename, 'utf8')).toBe(original)
        expect((await stat(filename)).mtimeMs).toBe(before.mtimeMs)
        expect(await readdir(path.dirname(filename))).toEqual(['matrix-runtime.d.ts'])
      }
      else {
        await expect(access(path.join(project, '.matrix'))).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(warning).toHaveBeenCalledTimes(1)
      expect(warning.mock.calls[0]?.[0]).toMatch(/Matrix.*injected environment.*skipping.*type generation/)
      expect(warning.mock.calls[0]?.[0]).toContain('matrix prepare')
      expect(warning.mock.calls[0]?.[0]).toContain('runtime configuration may be incomplete')
    },
  )

  it.each(hosts)('%s accepts empty schema metadata and removes stale fields', async (host) => {
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, '{}')
    vi.stubEnv('MAIN_VITE_WINDOW_TITLE', 'Matrix')
    const warning = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    const project = await projectDirectory()
    const filename = path.join(project, output)
    await hostRunner(host, project)()
    expect(await readFile(filename, 'utf8')).toContain('readonly MAIN_VITE_WINDOW_TITLE: string')

    vi.stubEnv('MAIN_VITE_WINDOW_TITLE', undefined)
    await hostRunner(host, project)()
    const empty = await readFile(filename, 'utf8')
    expect(empty).not.toContain('MAIN_VITE_WINDOW_TITLE')
    expect(empty).toContain('  interface MatrixConfig {\n  }')
    expect(empty).not.toContain(MATRIX_ENV_SCHEMA_KEY)
    expect(warning).not.toHaveBeenCalled()
  })

  it.each([...hosts.map(host => ({ host, metadata: '{}' })), { host: hosts[0], metadata: undefined }])(
    '$host honors types: false with metadata=$metadata',
    async ({ host, metadata }) => {
      vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, metadata)
      const project = await projectDirectory()
      const warning = vi.spyOn(consola, 'warn').mockImplementation(() => {})
      await hostRunner(host, project, { types: false })()
      await expect(access(path.join(project, '.matrix'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(warning).not.toHaveBeenCalled()
    },
  )

  // Both explicit forms override missing context and Vitest. Inline is an
  // independent switch; one runtime-only case per host preserves its contract.
  it.each(hosts.flatMap(host => [
    { name: 'types: true', types: true, vitest: undefined, inline: true },
    { name: 'custom output', types: { output: 'custom/runtime.d.ts' }, vitest: undefined, inline: true },
    { name: 'types: true in Vitest', types: true, vitest: 'true', inline: true },
    { name: 'custom output in Vitest without inlining', types: { output: 'custom/runtime.d.ts' }, vitest: 'true', inline: false },
  ].map(test => ({ host, ...test }))))(
    '$host allows $name without Matrix context',
    async ({ host, types, inline, vitest }) => {
      vi.stubEnv('VITEST', vitest)
      const project = await projectDirectory()
      vi.stubEnv('MAIN_VITE_WINDOW_TITLE', 'Matrix')
      const warning = vi.spyOn(consola, 'warn').mockImplementation(() => {})
      await hostRunner(host, project, { types, inline })()
      const filename = typeof types === 'object' ? types.output : output
      await expect(readFile(path.join(project, filename), 'utf8')).resolves.toContain('MAIN_VITE_WINDOW_TITLE')
      expect(warning).not.toHaveBeenCalled()
    },
  )

  it('generates types through CLI-injected context when the project has no envSchema', async () => {
    const project = await projectDirectory()
    process.chdir(project)
    const plugin = fileURLToPath(new URL('../../src/unplugin/vite.ts', import.meta.url))
    await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(project, 'node_modules'), 'junction')
    await writeFile(path.join(project, 'package.json'), '{"type":"module"}')
    await writeFile(path.join(project, 'matrix.config.mjs'), `export default {
      env: { MAIN_VITE_WINDOW_TITLE: 'Matrix CLI' },
      projects: { web: { targets: { build: 'node build.mjs' } } },
      products: { app: { variants: { web: 'web' } } },
    }`)
    await writeFile(path.join(project, 'vite.config.mjs'), `
      import matrix from ${JSON.stringify(plugin)};
      export default {
        envPrefix: ['MAIN_VITE_', '__MATRIX_'],
        plugins: [matrix()],
        logLevel: 'silent',
        build: { write: false, lib: { entry: './entry.js', formats: ['es'] } },
      };
    `)
    await writeFile(path.join(project, 'build.mjs'), `
      import { build } from 'vite';
      if (process.env.${MATRIX_ENV_SCHEMA_KEY} !== '{}') throw new Error('Missing CLI context');
      if (process.env.VITEST !== undefined) throw new Error('Vitest would suppress generation');
      await build();
    `)
    await runCli(['build', 'app'])
    const declarations = await readFile(path.join(project, output), 'utf8')
    expect(declarations).toContain('readonly MAIN_VITE_WINDOW_TITLE: string')
    expect(declarations).not.toContain(MATRIX_ENV_SCHEMA_KEY)
  })

  it.each(['', '{', 'null'])('still rejects malformed schema metadata %j', (metadata) => {
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, metadata)
    expect(() => MatrixUnplugin.vite()).toThrow('Invalid Matrix internal environment schema')
  })
})
