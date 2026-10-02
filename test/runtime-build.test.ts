import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRuntimeBuilder, hosts } from './helpers/runtime-build.js'
import { staticReadCase, stubRuntimeEnv } from './helpers/runtime-fixtures.js'

const builder = createRuntimeBuilder()
beforeEach(stubRuntimeEnv)
afterEach(async () => {
  vi.unstubAllEnvs()
  await builder.cleanup()
})

// Syntax and read/write semantics live in runtime-conformance.test.ts. These
// tests retain the independent production-mode and multi-scope contracts.
it.each(hosts)('%s preserves the frozen public runtime with inlining disabled', async (host) => {
  const built = await builder.build(host, {
    name: 'runtime-only integration',
    source: `import { matrix } from 'virtual:matrix/runtime';
      try { matrix.isProduction = false; } catch (error) { globalThis.events.push(error.name); }
      globalThis.result = [matrix.isProduction, matrix.config.enabled, matrix.config.limit,
        Object.isFrozen(matrix), Object.isFrozen(matrix.product), Object.isFrozen(matrix.config)];`,
  }, { plugins: [{ inline: false }] })
  expect(await built.run()).toEqual({ value: [true, false, 3, true, true, true], error: null, events: ['TypeError'] })
  for (const privateValue of ['PRIVATE_SENTINEL', 'MAIN_SENTINEL', 'PRELOAD_SENTINEL'])
    expect(built.code).not.toContain(privateValue)
})

it.each(['vite', 'esbuild', 'webpack'] as const)('deletes exclusive chunks with %s minification', async (host) => {
  const fixture = staticReadCase
  const built = await builder.build(host, fixture, { minify: true })
  expect(built.files).toHaveLength(1)
  expect(built.code).not.toContain('DEV_ONLY_SENTINEL')
  expect(await built.run()).toEqual({ value: fixture.value, error: null, events: [] })
})

it.each(hosts)('%s executes development-only chunks in development', async (host) => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('MATRIX_NODE_ENV', 'development')
  const built = await builder.build(host, {
    name: 'development branch',
    source: `import { matrix } from 'virtual:matrix/runtime';
      globalThis.result = matrix.isDevelopment ? import('./dev-only.js').then(() => 'development') : 'production';`,
  })
  expect(built.code).toContain('DEV_ONLY_SENTINEL')
  expect(built.files.length).toBeGreaterThan(1)
  expect(await built.run()).toEqual({ value: 'development', error: null, events: ['DEV_ONLY_SENTINEL'] })
})

it.each(['rollup', 'esbuild', 'webpack'] as const)('keeps coexisting scope bindings separate in %s', async (host) => {
  const built = await builder.build(host, {
    name: 'coexisting scopes',
    source: `import { matrix as main } from 'virtual:matrix/runtime/main';
      import { matrix as preload } from 'virtual:matrix/runtime/preload';
      globalThis.result = [main.config.only, preload.config.only, main.config, preload.config];`,
  }, { plugins: [{ scope: 'main', envPrefix: 'MAIN_VITE_' }, { scope: 'preload', envPrefix: 'PRELOAD_VITE_' }] })
  expect(await built.run()).toEqual({
    value: ['MAIN_SENTINEL', 'PRELOAD_SENTINEL', { only: 'MAIN_SENTINEL' }, { only: 'PRELOAD_SENTINEL' }],
    error: null,
    events: [],
  })
  expect(built.code).not.toContain('PRIVATE_SENTINEL')
})

it.each(hosts)('does not leak fields between independent scoped %s builds', async (host) => {
  for (const [scope, prefix, own, other] of [
    ['main', 'MAIN_VITE_', 'MAIN_SENTINEL', 'PRELOAD_SENTINEL'],
    ['preload', 'PRELOAD_VITE_', 'PRELOAD_SENTINEL', 'MAIN_SENTINEL'],
  ] as const) {
    const built = await builder.build(host, {
      name: scope,
      source: `import { matrix } from 'virtual:matrix/runtime/${scope}';
        globalThis.result = [matrix.config.only, matrix.config];`,
    }, { plugins: [{ scope, envPrefix: prefix }] })
    expect(await built.run()).toEqual({ value: [own, { only: own }], error: null, events: [] })
    expect(built.code).not.toContain(other)
    expect(built.code).not.toContain('PRIVATE_SENTINEL')
  }
})
