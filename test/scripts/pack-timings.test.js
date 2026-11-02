import process from 'node:process'
import { execa } from 'execa'
import { afterEach, expect, it, vi } from 'vitest'
import { expectFailure } from '../../scripts/pack-fixtures.mjs'
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

function interruptedCommand(exitCode, cancel) {
  const controller = new AbortController()
  const source = `
    import { getCancelSignal, sendMessage } from ${JSON.stringify(import.meta.resolve('execa'))};
    const finish = () => process.exit(${exitCode});
    ${cancel
      ? 'const signal = await getCancelSignal(); signal.addEventListener("abort", finish, { once: true });'
      : 'process.on("SIGTERM", finish);'}
    console.log("public stdout");
    console.error("expected diagnostic");
    await sendMessage("ready");
    setInterval(() => {}, 1000);
  `
  const subprocess = execa(process.execPath, ['--input-type=module', '-e', source], {
    ipc: true,
    ...(cancel
      ? { cancelSignal: controller.signal, gracefulCancel: true }
      : { timeout: 2000 }),
  })
  return { subprocess, ready: subprocess.getOneMessage(), cancel: () => controller.abort(new Error('fixture cancellation')) }
}

// Windows cannot run a SIGTERM handler before forced termination. Graceful
// cancellation below uses Execa IPC instead and exercises both exit codes there.
it.skipIf(process.platform === 'win32').each([0, 17])('keeps a timed-out command exiting %i failed', async (exitCode) => {
  const { timings, output } = captureTimings()
  const { subprocess, ready } = interruptedCommand(exitCode, false)
  const original = subprocess.catch(error => error)
  const measured = timings.measure('fixture', 'timeout', () => subprocess, { rejection: /expected diagnostic/, allowSuccess: true })
    .then(result => ({ result }), error => ({ error }))
  expect(await ready).toBe('ready')
  const error = await original
  expect(error).toMatchObject({ timedOut: true, exitCode, stdout: 'public stdout', stderr: 'expected diagnostic' })
  expect((await measured).error).toBe(error)
  await expect(expectFailure(subprocess, /expected diagnostic/, 'timeout')).rejects.toBe(error)
  timings.report()
  expect(output()).toContain('Package outcomes: failed 1')
  expect(output()).not.toContain('(expected rejection)')
}, 10000)

it.each([0, 17])('keeps a gracefully canceled command exiting %i failed', async (exitCode) => {
  const { timings, output } = captureTimings()
  const { subprocess, ready, cancel } = interruptedCommand(exitCode, true)
  const original = subprocess.catch(error => error)
  const measured = timings.measure('fixture', 'cancel', () => subprocess, { rejection: /expected diagnostic/, allowSuccess: true })
    .then(result => ({ result }), error => ({ error }))
  expect(await ready).toBe('ready')
  cancel()
  const error = await original
  expect(error).toMatchObject({ isCanceled: true, isGracefullyCanceled: true, exitCode, stdout: 'public stdout', stderr: 'expected diagnostic' })
  expect(error.cause).toMatchObject({ message: 'fixture cancellation' })
  expect((await measured).error).toBe(error)
  await expect(expectFailure(subprocess, /expected diagnostic/, 'cancel')).rejects.toBe(error)
  timings.report()
  expect(output()).toContain('Package outcomes: failed 1')
  expect(output()).not.toContain('(expected rejection)')
}, 10000)
