import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MATRIX_ENV_SCHEMA_KEY } from '../src/env-schema.js'
import { createRuntimeBuilder, hosts } from './helpers/runtime-build.js'
import { readCases, stubRuntimeEnv, writeCases } from './helpers/runtime-fixtures.js'

const builder = createRuntimeBuilder()
beforeEach(stubRuntimeEnv)
afterEach(async () => {
  vi.unstubAllEnvs()
  await builder.cleanup()
})

const paths = [
  { name: 'shared transform before type erasure', host: 'esbuild' as const, mode: 'shared' as const },
  ...hosts.map(host => ({ name: host, host, mode: 'plugin' as const })),
]

describe.each(paths)('$name runtime conformance', ({ host, mode }) => {
  it.each(readCases)('$name', async (fixture) => {
    const baseline = await builder.build(host, fixture, { mode: 'reference' })
    const optimized = await builder.build(host, fixture, { mode })
    const expected = { value: fixture.value, error: fixture.error ?? null, events: fixture.events ?? [] }
    // Explicit expectations prevent two identically wrong executions from
    // passing. Every failure includes the small, deterministic source fixture.
    const original = await baseline.run()
    expect(original, fixture.source).toEqual(expected)
    expect(await optimized.run(), fixture.source).toEqual(original)
    if (fixture.dce) {
      expect(optimized.files, fixture.source).toHaveLength(1)
      expect(optimized.code, fixture.source).not.toContain('DEV_ONLY_SENTINEL')
    }
    for (const privateValue of ['PRIVATE_SENTINEL', 'MAIN_SENTINEL', 'PRELOAD_SENTINEL', MATRIX_ENV_SCHEMA_KEY])
      expect(optimized.code, fixture.source).not.toContain(privateValue)
  })

  it.each(writeCases)('rejects $name', async (fixture) => {
    // Earlier rejection is intentional: direct writes are build errors, not
    // differential runtime equivalence cases. Parser/type errors do not count.
    await expect(builder.build(host, fixture, { mode }), fixture.source).rejects.toThrow('Matrix snapshot is read-only')
  })
})
