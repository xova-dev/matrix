import process from 'node:process'
import { execa } from 'execa'
import { afterEach, expect, it, vi } from 'vitest'
import { createPackageTimings } from '../../scripts/pack-timings.mjs'

afterEach(() => vi.restoreAllMocks())

function captureTimings() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  return { timings: createPackageTimings(), output: () => log.mock.calls.flat().join('\n') }
}

function command(source) {
  return execa(process.execPath, ['-e', source])
}

it('reports asserted command rejection separately and retains the real process diagnostics', async () => {
  const { timings, output } = captureTimings()
  const result = await timings.measure('fixture', 'negative', () => command('console.log("public stdout"); console.error("expected diagnostic"); process.exitCode = 17'), { rejection: /expected diagnostic/ })
  expect(result.exitCode).toBe(17)
  expect(result.stdout).toBe('public stdout')
  expect(result.stderr).toBe('expected diagnostic')
  timings.report()
  expect(output()).toContain('(expected rejection)')
  expect(output()).toContain('Package outcomes: expected rejection 1')
  expect(output()).not.toContain('failed')
})

it('keeps ordinary failures rejected and counts both failed and successful phases', async () => {
  const { timings, output } = captureTimings()
  await timings.measure('fixture', 'positive', () => command('console.log("success")'))
  await expect(timings.measure('fixture', 'broken', () => command('console.error("broken"); process.exitCode = 23'))).rejects.toMatchObject({
    exitCode: 23,
    stderr: 'broken',
  })
  timings.report()
  expect(output()).toContain('Package outcomes: passed 1, failed 1')
})

it.each([
  ['unexpected success', () => command('console.error("expected")'), /expected/],
  ['wrong diagnostic', () => command('console.error("unrelated"); process.exitCode = 1'), /expected/],
  ['non-process error', () => Promise.reject(new Error('expected')), /expected/],
  ['missing executable', () => execa('matrix-nonexistent-fixture-command'), /ENOENT/],
])('does not classify %s as an expected rejection', async (_, operation, rejection) => {
  const { timings, output } = captureTimings()
  await expect(timings.measure('fixture', 'negative', operation, { rejection })).rejects.toThrow()
  timings.report()
  expect(output()).toContain('Package outcomes: failed 1')
  expect(output()).not.toContain('(expected rejection)')
})

it('allows either native-loader outcome only when a rejected diagnostic matches', async () => {
  const { timings, output } = captureTimings()
  const expectation = { rejection: /native unsupported/, allowSuccess: true }
  const accepted = await timings.measure('fixture', 'native-accepted', () => command(''), expectation)
  const rejected = await timings.measure('fixture', 'native-rejected', () => command('console.error("native unsupported"); process.exitCode = 1'), expectation)
  expect(accepted.exitCode).toBe(0)
  expect(rejected.exitCode).toBe(1)
  await expect(timings.measure('fixture', 'native-broken', () => command('console.error("unrelated"); process.exitCode = 1'), expectation)).rejects.toThrow()
  timings.report()
  expect(output()).toContain('Package outcomes: passed 1, expected rejection 1, failed 1')
})
