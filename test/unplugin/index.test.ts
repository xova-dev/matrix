import type { MatrixUnpluginOptions } from '../../src/unplugin/index.js'
import { Buffer } from 'node:buffer'
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import consola from 'consola'
import path from 'pathe'
import { rollup } from 'rollup'
import { build, resolveConfig } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MATRIX_ENV_SCHEMA_KEY, MATRIX_TYPE_CONTRACT_KEY } from '../../src/config/env-schema.js'
import { preparedTypeDeclaration } from '../../src/typegen/coordination.js'
import { generateMatrixTypes } from '../../src/typegen/generate.js'
import { MatrixUnplugin } from '../../src/unplugin/index.js'
import { resolveFuturePath } from '../../src/utils/path.js'

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
  it.each([true, false])('keeps host additions out of the prepared runtime and types (inline=%s)', async (inline) => {
    const project = await projectDirectory()
    const shared = {
      cwd: project,
      env: { VITE_API_BASE: 'prepared' },
      envSchema: { VITE_ENABLED: { type: 'boolean' as const } },
      envPrefix: ['VITE_', 'MATRIX_', '__MATRIX_'],
    }
    const filename = await generateMatrixTypes(shared)
    const complete = await readFile(filename, 'utf8')
    const declaration = preparedTypeDeclaration({ ...shared, output: await resolveFuturePath(filename) })
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, JSON.stringify(shared.envSchema))
    vi.stubEnv(MATRIX_TYPE_CONTRACT_KEY, JSON.stringify({ strict: true, declarations: [declaration] }))
    vi.stubEnv('VITE_API_BASE', 'active')
    vi.stubEnv('VITE_ENABLED', 'true')
    const additions = {
      VITE_ROOT_DIR: '/host/root',
      VITE_USER_NODE_ENV: 'production',
      VITE_CJS_IGNORE_WARNING: 'true',
      VITE_OTHER_HOST_FIELD: 'host-only',
    }
    for (const [key, value] of Object.entries(additions))
      vi.stubEnv(key, value)
    await writeFile(path.join(project, 'entry.js'), `
      import { matrix } from 'virtual:matrix/runtime'
      export const config = matrix.config
      export const enabled = matrix.config.enabled
      export const hostRoot = import.meta.env.VITE_ROOT_DIR
    `)
    const built = await build({
      root: project,
      configFile: false,
      envFile: false,
      envPrefix: shared.envPrefix,
      plugins: [MatrixUnplugin.vite({ inline, types: true })],
      logLevel: 'silent',
      build: { write: false, minify: false, lib: { entry: path.join(project, 'entry.js'), formats: ['es'] } },
    })
    const result = Array.isArray(built) ? built[0] : built
    if (!result || !('output' in result))
      throw new Error('Expected a completed Vite build')
    const chunk = result.output.find(item => item.type === 'chunk')
    expect(chunk).toBeDefined()
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(chunk!.code).toString('base64')}`)
    expect(runtime.config).toEqual({ apiBase: 'active', enabled: true })
    expect(runtime.enabled).toBe(true)
    expect(runtime.hostRoot).toBe('/host/root')
    expect(await readFile(filename, 'utf8')).toBe(complete)
    expect(complete).toContain('readonly enabled: boolean')
    expect(complete).not.toContain('rootDir')
  })

  it('rejects prepared-contract conflicts during configuration without replacing declarations', async () => {
    const project = await projectDirectory()
    const shared = {
      cwd: project,
      env: { MAIN_VITE_API_BASE: 'prepared' },
      envSchema: { MAIN_VITE_ENABLED: { type: 'boolean' as const } },
      envPrefix: ['MAIN_VITE_', 'MATRIX_', '__MATRIX_'],
    }
    const filename = await generateMatrixTypes(shared)
    const complete = await readFile(filename, 'utf8')
    const declaration = preparedTypeDeclaration({ ...shared, output: await resolveFuturePath(filename) })
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, JSON.stringify(shared.envSchema))
    vi.stubEnv(MATRIX_TYPE_CONTRACT_KEY, JSON.stringify({ strict: true, declarations: [declaration] }))
    const resolveProject = async () => hostRunner('vite config', project, { types: true })()
    // A late alias conflicts even if the prepared original is absent in this product.
    vi.stubEnv('MAIN_VITE_ENABLED', 'true')
    vi.stubEnv('MAIN_VITE_API__BASE', 'ambiguous')
    await expect(resolveProject()).rejects.toThrow('Ambiguous environment fields')
    vi.stubEnv('MAIN_VITE_API__BASE', undefined)
    vi.stubEnv('MAIN_VITE_ENABLED', 'invalid')
    await expect(resolveProject()).rejects.toThrow('Invalid environment field MAIN_VITE_ENABLED: expected boolean')
    vi.stubEnv('MAIN_VITE_ENABLED', undefined)
    await expect(resolveProject()).rejects.toThrow('Missing required environment field MAIN_VITE_ENABLED')
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, JSON.stringify({ MAIN_VITE_ENABLED: { type: 'string' } }))
    await expect(resolveProject()).rejects.toThrow('Matrix type contract changed after collection')
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, JSON.stringify({ MATRIX_TARGET: { type: 'string' } }))
    await expect(resolveProject()).rejects.toThrow('Invalid Matrix internal environment schema')
    expect(await readFile(filename, 'utf8')).toBe(complete)
  })

  it('keeps Rollup generation host-local when Vite collection injects an empty strict contract', async () => {
    const project = await projectDirectory()
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, '{}')
    // A discoverable Vite config without Matrix plugins produces this handshake.
    vi.stubEnv(MATRIX_TYPE_CONTRACT_KEY, JSON.stringify({ strict: true, declarations: [] }))
    vi.stubEnv('MAIN_VITE_WINDOW_TITLE', 'Matrix')
    await hostRunner('rollup build', project)()
    const types = await readFile(path.join(project, output), 'utf8')
    expect(types).toContain('readonly windowTitle: string')
    expect(types).not.toContain(MATRIX_TYPE_CONTRACT_KEY)
  })

  it('accepts a schema-declared optional field populated only after Vite collection', async () => {
    const project = await projectDirectory()
    const shared = {
      cwd: project,
      env: {},
      envSchema: { MAIN_VITE_OPTIONAL: { type: 'string' as const, optional: true } },
      envPrefix: ['MAIN_VITE_', 'MATRIX_', '__MATRIX_'],
    }
    const filename = await generateMatrixTypes(shared)
    const complete = await readFile(filename, 'utf8')
    expect(complete).toContain('readonly optional?: string')
    const declaration = preparedTypeDeclaration({ ...shared, output: await resolveFuturePath(filename) })
    expect(declaration.keys).toContain('MAIN_VITE_OPTIONAL')
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, JSON.stringify(shared.envSchema))
    vi.stubEnv(MATRIX_TYPE_CONTRACT_KEY, JSON.stringify({ strict: true, declarations: [declaration] }))
    vi.stubEnv('MAIN_VITE_OPTIONAL', 'late-private-value')
    await hostRunner('vite config', project)()
    expect(await readFile(filename, 'utf8')).toBe(complete)
  })

  it.each(['direct', 'aliased'])('consumes a complete coordinated contract through a %s root without publishing an active-product subset', async (root) => {
    let project = await projectDirectory()
    if (root === 'aliased') {
      const alias = `${project}-alias`
      await symlink(project, alias, 'junction')
      temporaryDirectories.push(alias)
      project = alias
    }
    const shared = {
      cwd: project,
      env: { MAIN_VITE_ALPHA: '', MAIN_VITE_BETA: '' },
      optionalEnvKeys: ['MAIN_VITE_ALPHA', 'MAIN_VITE_BETA'],
      envPrefix: ['MAIN_VITE_', 'MATRIX_', '__MATRIX_'],
    }
    const filename = await generateMatrixTypes(shared)
    const complete = await readFile(filename, 'utf8')
    // The coordinator publishes canonical output identities, as the host does.
    // Temp roots may use aliases (/var or Windows short names).
    const declaration = preparedTypeDeclaration({ ...shared, output: await resolveFuturePath(filename) })
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, '{}')
    vi.stubEnv(MATRIX_TYPE_CONTRACT_KEY, JSON.stringify({ strict: true, declarations: [declaration] }))
    vi.stubEnv('MAIN_VITE_ALPHA', 'active')
    await hostRunner('vite config', project, { types: true })()
    expect(await readFile(filename, 'utf8')).toBe(complete)
    expect(complete).not.toContain(MATRIX_TYPE_CONTRACT_KEY)
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

  it.each(['', '{', 'null'])('still rejects malformed schema metadata %j', (metadata) => {
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, metadata)
    expect(() => MatrixUnplugin.vite()).toThrow('Invalid Matrix internal environment schema')
  })
})
