import type { EnvSchema, MatrixConfig } from '../../src/types.js'
import type { MatrixUnpluginOptions } from '../../src/unplugin/index.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { runInNewContext } from 'node:vm'
import path from 'pathe'
import { rollup } from 'rollup'
import { build } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MATRIX_ENV_SCHEMA_KEY, serializeEnvSchema } from '../../src/config/env-schema.js'
import { defineMatrixConfig, defineMatrixEnv, loadMatrixConfig, normalizeMatrixConfig } from '../../src/config/index.js'
import { assertMatrixConfig } from '../../src/config/schema.js'
import { runExecutionPlan } from '../../src/execution/exec.js'
import { createExecutionPlan } from '../../src/execution/plan.js'
import { createMatrixRuntime } from '../../src/runtime/snapshot.js'
import { generateMatrixTypes } from '../../src/typegen/generate.js'
import { MatrixUnplugin } from '../../src/unplugin/index.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-env-schema-'))
  directories.push(cwd)
  return cwd
}

const envSchema: EnvSchema = {
  VITE_ENABLED: { type: 'boolean', default: true },
  VITE_LIMIT: { type: 'number', default: 3 },
  VITE_MODE: { type: 'enum', values: ['remote', 'bundled'], default: 'remote' },
  VITE_LABEL: { type: 'string', optional: true },
  MAIN_VITE_REQUIRED: { type: 'string' },
  PRIVATE_SECRET: { type: 'string', default: 'private-default-marker' },
}

function config(): MatrixConfig {
  return {
    envSchema,
    env: { VITE_LIMIT: 4 },
    projects: { web: { targets: { build: 'node build.mjs' } } },
    products: { app: { env: { VITE_LIMIT: 5 }, variants: { web: 'web' } } },
  }
}

function plan(raw: MatrixConfig, cwd: string, externalEnv = {}) {
  return createExecutionPlan({ ...normalizeMatrixConfig(raw), cwd, externalEnv, productNames: ['app'], target: 'build', envName: 'production' })
}

async function buildVite(cwd: string, source: string, options: MatrixUnpluginOptions = { types: false }, envPrefix = ['VITE_']): Promise<string> {
  const entry = path.join(cwd, 'entry.js')
  await writeFile(entry, source)
  const result = await build({
    root: cwd,
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
    envPrefix,
    plugins: [MatrixUnplugin.vite(options)],
    build: { write: false, minify: false, lib: { entry, formats: ['iife'], name: 'fixture' } },
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!output || !('output' in output))
    throw new Error('Expected a completed Vite build')
  const chunk = output.output.find(item => item.type === 'chunk')
  if (!chunk)
    throw new Error('Expected a JavaScript output chunk')
  return chunk.code
}

describe('root envSchema', () => {
  it('resolves defaults and final overrides, preserving runtime types and raw env strings', async () => {
    const cwd = await workspace()
    expect(plan(config(), cwd).tasks[0]!.env.VITE_LIMIT).toBe('5')
    const execution = plan(config(), cwd, { VITE_ENABLED: 'false', VITE_LIMIT: '6.5', VITE_MODE: 'bundled', VITE_LEGACY: 'false' })
    await writeFile(path.join(cwd, 'build.mjs'), [
      'import { writeFileSync } from "node:fs"',
      'writeFileSync("captured.json", JSON.stringify(process.env))',
    ].join('\n'))
    execution.tasks[0]!.command = `"${process.execPath}" build.mjs`
    await runExecutionPlan(execution)
    const captured = JSON.parse(await readFile(path.join(cwd, 'captured.json'), 'utf8'))
    expect(captured.VITE_ENABLED).toBe('false')
    expect(captured.VITE_LIMIT).toBe('6.5')
    expect(captured[MATRIX_ENV_SCHEMA_KEY]).not.toContain('private-default-marker')
    const runtime = createMatrixRuntime(captured)
    expect(runtime.config).toEqual({ enabled: false, limit: 6.5, mode: 'bundled', legacy: 'false' })
    expect(JSON.stringify(runtime)).not.toContain('PRIVATE_SECRET')
    expect(JSON.stringify(runtime)).not.toContain('private-default-marker')
  })

  it('loads declarations through the worker and respects environment, dotenv, and shell precedence', async () => {
    const cwd = await workspace()
    const raw = config()
    raw.products.app!.$env = { production: { env: { VITE_LIMIT: 7 } } }
    await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default ${JSON.stringify(raw)}`)
    vi.stubEnv('VITE_LIMIT', undefined)
    const value = async () => {
      const loaded = await loadMatrixConfig({ cwd, envName: 'production' })
      return createExecutionPlan({ ...loaded, productNames: ['app'], target: 'build' }).tasks[0]!.env.VITE_LIMIT
    }
    expect(await value()).toBe('7')
    await writeFile(path.join(cwd, '.env.production'), 'VITE_LIMIT=8\n')
    expect(await value()).toBe('8')
    vi.stubEnv('VITE_LIMIT', '9')
    expect(await value()).toBe('9')
    vi.stubEnv('VITE_LIMIT', 'private-invalid-marker')
    await expect(value()).rejects.toThrow('Invalid environment field VITE_LIMIT: expected number')
  })

  it.each([
    ['VITE_ENABLED', '0'],
    ['VITE_ENABLED', 'FALSE'],
    ['VITE_LIMIT', ''],
    ['VITE_LIMIT', ' 1 '],
    ['VITE_LIMIT', 'Infinity'],
    ['VITE_LIMIT', 'NaN'],
    ['VITE_LIMIT', '0x10'],
    ['VITE_MODE', 'private-invalid-marker'],
    ['VITE_LABEL', false],
  ])('rejects invalid final %s without fallback or disclosure', async (key, value) => {
    const cwd = await workspace()
    expect(() => plan(config(), cwd, { [key]: value })).toThrow(new RegExp(`^Invalid environment field ${key}: expected (boolean|number|enum|string)$`))
  })

  it('checks required fields only in the consuming prefix and omits absent optional fields', async () => {
    const cwd = await workspace()
    const task = plan(config(), cwd).tasks[0]!
    const env = Object.fromEntries(Object.entries(task.env).map(([key, value]) => [key, String(value)]))
    expect(createMatrixRuntime(env, ['VITE_'], envSchema).config).toEqual({ enabled: true, limit: 5, mode: 'remote' })
    expect(() => createMatrixRuntime(env, ['MAIN_VITE_'], envSchema)).toThrow('Missing required environment field MAIN_VITE_REQUIRED')
    expect(createMatrixRuntime({ MAIN_VITE_REQUIRED: 'main' }, ['MAIN_VITE_'], envSchema).config).toEqual({ required: 'main' })
  })

  it('validates final Vite env without a runtime import or type generation', async () => {
    const cwd = await workspace()
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, serializeEnvSchema({ VITE_REQUIRED: { type: 'boolean' }, MAIN_VITE_REQUIRED: { type: 'string' } }))
    const compile = () => buildVite(cwd, 'export const raw = import.meta.env.VITE_REQUIRED')
    vi.stubEnv('VITE_REQUIRED', undefined)
    await expect(compile()).rejects.toThrow('Missing required environment field VITE_REQUIRED')
    vi.stubEnv('VITE_REQUIRED', 'invalid')
    await expect(compile()).rejects.toThrow('Invalid environment field VITE_REQUIRED: expected boolean')
    vi.stubEnv('VITE_REQUIRED', 'false')
    const code = await compile()
    expect(runInNewContext(`${code}; fixture`).raw).toBe('false')
  })

  it('validates non-Vite builds at startup without loading a virtual module', async () => {
    const cwd = await workspace()
    const entry = path.join(cwd, 'entry.js')
    await writeFile(entry, 'export const value = 42')
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, serializeEnvSchema({ VITE_REQUIRED: { type: 'boolean' }, MAIN_VITE_REQUIRED: { type: 'string' } }))
    vi.stubEnv('VITE_REQUIRED', undefined)
    const start = async (): Promise<void> => {
      const bundle = await rollup({ input: entry, plugins: [MatrixUnplugin.rollup({ types: false })] })
      try {
        await bundle.generate({ format: 'es' })
      }
      finally {
        await bundle.close()
      }
    }
    await expect(start()).rejects.toThrow('Missing required environment field VITE_REQUIRED')
    vi.stubEnv('VITE_REQUIRED', 'invalid')
    await expect(start()).rejects.toThrow('Invalid environment field VITE_REQUIRED: expected boolean')
    vi.stubEnv('VITE_REQUIRED', 'false')
    await expect(start()).resolves.toBeUndefined()
  })

  it('builds scoped typed runtime without leaking schema through either Vite env access form', async () => {
    const cwd = await workspace()
    vi.stubEnv(MATRIX_ENV_SCHEMA_KEY, serializeEnvSchema(envSchema))
    vi.stubEnv('VITE_ENABLED', 'false')
    vi.stubEnv('VITE_LIMIT', '2')
    vi.stubEnv('VITE_MODE', 'bundled')
    const code = await buildVite(cwd, [
      'export { matrix } from "virtual:matrix/runtime/renderer"',
      'export const direct = import.meta.env.__MATRIX_ENV_SCHEMA',
      'export const all = import.meta.env',
    ].join('\n'), { scope: 'renderer', types: true }, ['VITE_', '__MATRIX_'])
    const output = runInNewContext(`${code}; fixture`)
    expect(output.matrix.config).toMatchObject({ enabled: false, limit: 2, mode: 'bundled' })
    expect(output.direct).toBeUndefined()
    expect(output.all[MATRIX_ENV_SCHEMA_KEY]).toBeUndefined()
    expect(output.all.VITE_ENABLED).toBe('false')
    expect(code).not.toContain('MAIN_VITE_REQUIRED')
    expect(code).not.toContain('PRIVATE_SECRET')
    expect(code).not.toContain('private-default-marker')
    const types = await readFile(path.join(cwd, '.matrix/types/matrix-runtime-renderer.d.ts'), 'utf8')
    expect(types).toContain('readonly enabled: boolean')
    expect(types).toContain('readonly limit: number')
    expect(types).toContain('readonly mode: "remote" | "bundled"')
    expect(types).toContain('readonly label?: string')
    expect(types).toContain('readonly VITE_ENABLED: string')
    expect(types).not.toContain('PRIVATE_SECRET')
    expect(types).not.toContain('MAIN_VITE_REQUIRED')
  })

  it('generates types from declarations, including absent and defaulted fields', async () => {
    const cwd = await workspace()
    const output = await generateMatrixTypes({ cwd, env: { VITE_LEGACY: 'opaque-value' }, envSchema: {
      ...envSchema,
      VITE_DEFAULTED: { type: 'boolean', optional: true, default: false },
    } })
    const types = await readFile(output, 'utf8')
    expect(types).toContain('readonly enabled: boolean')
    expect(types).toContain('readonly defaulted: boolean')
    expect(types).toContain('readonly label?: string')
    expect(types).toContain('readonly legacy: string')
    expect(types).not.toContain('opaque-value')
    expect(types).not.toContain('private-default-marker')
  })

  it('rejects ambiguous typed properties without changing legacy string collisions', async () => {
    const cwd = await workspace()
    const env = { VITE_ENABLED: 'false', MAIN_VITE_ENABLED: 'legacy' }
    const prefixes = ['MAIN_VITE_', 'VITE_']
    expect(() => createMatrixRuntime(env, prefixes, envSchema)).toThrow('Ambiguous environment fields')
    await expect(generateMatrixTypes({ cwd, env, envPrefix: prefixes, envSchema })).rejects.toThrow('Ambiguous environment fields')
    expect(createMatrixRuntime(env, prefixes).config.enabled).toBe('false')
  })

  it.each([
    { VITE_TEST: { type: 'enum', values: [] } },
    { VITE_TEST: { type: 'enum', values: ['remote'], default: 'private-invalid-marker' } },
    { VITE_TEST: { type: 'boolean', default: 'false' } },
    { VITE_TEST: { type: 'number', default: Number.NaN } },
    { VITE_TEST: { type: 'number', optional: 'true' } },
    { MATRIX_PRODUCT_VERSION: { type: 'string' } },
    { NODE_ENV: { type: 'string' } },
  ])('rejects invalid schema declarations', (schema) => {
    expect(() => assertMatrixConfig({ ...config(), envSchema: schema })).toThrow()
  })

  it('constrains configuration inputs from root declarations', () => {
    const schema = { VITE_MODE: { type: 'enum', values: ['remote', 'bundled'] }, VITE_ENABLED: { type: 'boolean' } } as const
    const base = { envSchema: schema, projects: {}, products: {} }
    defineMatrixConfig({ ...base, env: { VITE_MODE: 'remote', VITE_ENABLED: false, OTHER: 123 } })
    defineMatrixConfig({ ...base, $env: defineMatrixEnv({ qa: { VITE_MODE: 'bundled' } }) })
    // @ts-expect-error An override must use a declared enum member.
    defineMatrixConfig({ ...base, env: { VITE_MODE: 'other' } })
    // @ts-expect-error Product values follow the same root contract.
    defineMatrixConfig({ ...base, products: { app: { env: { VITE_ENABLED: 1 }, variants: {} } } })
    // @ts-expect-error Environment overrides follow the root contract.
    defineMatrixConfig({ ...base, products: { app: { $env: { qa: { env: { VITE_MODE: 'other' } } }, variants: {} } } })
    // @ts-expect-error Enum defaults must belong to the declared set.
    defineMatrixConfig({ ...base, envSchema: { VITE_MODE: { type: 'enum', values: ['remote'], default: 'other' } } })
  })
})
