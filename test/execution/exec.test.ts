import type { ExecutionPlan, ExecutionTask } from '../../src/types.js'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import consola from 'consola'
import path from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runExecutionPlan as executePlan } from '../../src/execution/exec.js'
import { expectProcessStopped, processExists } from '../helpers/process-fixture.js'
import { temporaryDirectory as createTemporaryDirectory } from '../helpers/temporary-directory.js'
import { createTestExecution } from '../helpers/test-execution.js'
import { cleanupTimeout, fixtureReadyTimeout, processTestTimeout } from '../helpers/timeouts.js'

const executions = createTestExecution()
function runExecutionPlan(plan: ExecutionPlan, options?: Parameters<typeof executePlan>[1], beforeStop?: () => void) {
  return executions.run(() => executePlan(plan, options), beforeStop && (() => {
    try {
      beforeStop()
    }
    finally {
      process.emit('SIGTERM')
    }
  }))
}
const temporaryDirectory = (prefix: string) => createTemporaryDirectory(prefix, () => executions.cleanup())

function task(id: string, command: string, overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    id,
    product: 'app',
    variant: id.split(':')[1] ?? id,
    project: 'project',
    projectRoot: process.cwd(),
    target: 'test',
    name: id,
    slug: id,
    command,
    cwd: process.cwd(),
    env: {},
    continuous: false,
    outputDir: path.join(os.tmpdir(), `matrix-test-output-${randomUUID()}`),
    dependsOn: [],
    ...overrides,
  }
}

const scriptCommand = [process.execPath, fileURLToPath(new URL('../fixtures/exec-child.cjs', import.meta.url))]
  .map(value => `"${value}"`)
  .join(' ')
  // Keep a real shell parent on POSIX, including shells that otherwise exec the last command.
  + (process.platform === 'win32' ? '' : '; exit $?')

function scriptedTask(id: string, script: string, overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return task(id, scriptCommand, {
    ...overrides,
    env: {
      MATRIX_TEST_SCRIPT: Buffer.from(script).toString('base64'),
      ...overrides.env,
    },
  })
}

function plan(tasks: ExecutionTask[]): ExecutionPlan {
  return { envName: 'development', tasks, artifactsRoot: process.cwd(), artifactRetention: 5 }
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Failed to allocate a test port')
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  return port
}

async function waitForFile(file: string): Promise<void> {
  await vi.waitFor(() => fs.access(file), { timeout: fixtureReadyTimeout })
}

let messages: string[]

beforeEach((ctx) => {
  executions.begin(ctx.signal)
  messages = []
  vi.spyOn(consola, 'info').mockImplementation((message) => {
    messages.push(String(message))
  })
})

afterEach(async () => {
  vi.useRealTimers()
  try {
    await executions.cleanup()
  }
  finally {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    vi.unstubAllEnvs()
  }
}, cleanupTimeout)

function summary(): string {
  const summaries = messages.filter(message => message.startsWith('Execution '))
  expect(summaries).toHaveLength(1)
  return summaries[0]!
}

function holdDirectoryCheck(cwd: string) {
  let checking!: () => void
  const entered = new Promise<void>(resolve => checking = resolve)
  let release!: () => void
  const resumed = new Promise<void>(resolve => release = resolve)
  const originalStat = fs.stat
  vi.spyOn(fs, 'stat').mockImplementation(async (...args: unknown[]) => {
    if (args[0] === cwd) {
      checking()
      await resumed
    }
    return Reflect.apply(originalStat, fs, args)
  })
  syncBuiltinESMExports()
  return {
    entered,
    release,
  }
}

// Real process containers include platform startup and disposal; use the same
// integration budget as preparation, including cold Windows PowerShell/.NET.
describe('runExecutionPlan', { timeout: processTestTimeout }, () => {
  it('does not let an already completed service end another live service', async () => {
    const cwd = await temporaryDirectory('matrix-exec-service-completion-')
    const marker = path.join(cwd, 'finished')
    const first = scriptedTask('app:first:dev', 'process.exit(0)', { continuous: true })
    const second = scriptedTask('app:second:dev', 'setTimeout(() => require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "yes"), 150)', {
      continuous: true,
      env: { MATRIX_TEST_MARKER: marker },
      dependsOn: [{ id: first.id, condition: 'completed' }],
    })
    const result = await runExecutionPlan(plan([first, second]))
    expect(result.cancelled).toBe(false)
    expect(await fs.readFile(marker, 'utf8')).toBe('yes')
    await expect(result.children.get(first.id)!.result).resolves.toMatchObject({ exitCode: 0 })
    await expect(result.children.get(second.id)!.result).resolves.toMatchObject({ exitCode: 0 })
  })

  it('identifies a failing ordered step without echoing commands or dumping environments', async () => {
    const cwd = await temporaryDirectory('matrix-exec-steps-')
    const marker = path.join(cwd, 'steps')
    const ordered = scriptedTask('app:ordered1:test', [
      'const fs = require("node:fs")',
      'fs.appendFileSync(process.env.MATRIX_TEST_MARKER, "step;")',
      'if (fs.readFileSync(process.env.MATRIX_TEST_MARKER, "utf8") === "step;step;") process.exit(7)',
    ].join(String.fromCharCode(10)), {
      env: { MATRIX_TEST_MARKER: marker, TOKEN_REFRESH_ENABLED: '1' },
    })
    const command = `${scriptCommand.replace('; exit $?', '')} --token=literal-secret-fixture`
    ordered.command = [command, command, command]
    const completed = task('app:echo:test', 'echo')
    const next = scriptedTask('app:next:test', 'process.exit(0)')

    await expect(runExecutionPlan(plan([completed, ordered, next])))
      .rejects
      .toThrow('app:ordered1:test exited with code 7')

    expect(await fs.readFile(marker, 'utf8')).toBe('step;step;')
    expect(summary()).toContain('app:echo:test: completed')
    expect(summary()).toContain('app:ordered1:test: failed')
    expect(summary()).toContain('app:next:test: not run')
    expect(summary()).toContain('step 2/3')
    expect(messages.join(' ')).not.toMatch(/literal-secret-fixture|TOKEN_REFRESH_ENABLED|--token/)
  })

  it('reports native command startup failures without dumping the subprocess error command', async () => {
    const cwd = await temporaryDirectory('matrix-exec-spawn-')
    const missing = scriptedTask('app:missing:test', 'process.exit(0)', { cwd: path.join(cwd, 'missing') })
    missing.command = `${scriptCommand.replace('; exit $?', '')} --password=spawn-secret-fixture`

    await expect(runExecutionPlan(plan([missing]))).rejects.toThrow('ENOENT')
    expect(summary()).toContain('app:missing:test: failed')
    expect(summary()).toContain('command, project project, step 1/1')
    expect(messages.join(' ')).not.toContain('spawn-secret-fixture')
  })

  it.each(['missing', 'dangling-junction', 'file'])('rejects an invalid %s cwd before the shell can run elsewhere', async (kind) => {
    const root = await temporaryDirectory('matrix-exec-cwd-')
    const cwd = path.join(root, 'selected')
    const marker = path.join(root, 'unexpected-command')
    if (kind === 'dangling-junction')
      await fs.symlink(path.join(root, 'not-mounted'), cwd, 'junction')
    else if (kind === 'file')
      await fs.writeFile(cwd, 'not a directory')
    const command = scriptedTask('app:invalid:test', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, process.cwd())', {
      cwd,
      env: { MATRIX_TEST_MARKER: marker },
    })
    await expect(runExecutionPlan(plan([command]))).rejects.toThrow(kind === 'file' ? 'not a directory' : 'ENOENT')
    expect(existsSync(marker)).toBe(false)
    expect(summary()).toContain('app:invalid:test: failed')
    expect(summary()).toContain('command, project project, step 1/1')
  })

  it('checks preparation cwd at startup, after preceding commands can create it', async () => {
    const root = await temporaryDirectory('matrix-exec-prepare-cwd-')
    const cwd = path.join(root, 'created')
    const setup = scriptedTask('app:setup:test', 'require("node:fs").mkdirSync(process.env.MATRIX_TEST_DIRECTORY)', {
      env: { MATRIX_TEST_DIRECTORY: cwd },
    })
    const prepared = scriptedTask('prepare:project', 'require("node:fs").writeFileSync("prepared", process.cwd())', { cwd })
    const target = scriptedTask('app:target:test', 'require("node:fs").writeFileSync("target", process.cwd())', { cwd })
    await runExecutionPlan({
      ...plan([setup, target]),
      preparations: [{ ...prepared, beforeTask: target.id }],
    })
    expect(await fs.realpath(await fs.readFile(path.join(cwd, 'prepared'), 'utf8'))).toBe(await fs.realpath(cwd))
    expect(await fs.realpath(await fs.readFile(path.join(cwd, 'target'), 'utf8'))).toBe(await fs.realpath(cwd))
  })

  it('reports invalid preparation cwd and leaves the target unstarted', async () => {
    const root = await temporaryDirectory('matrix-exec-prepare-missing-')
    const marker = path.join(root, 'unexpected-command')
    const command = scriptedTask('app:target:test', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "ran")', {
      env: { MATRIX_TEST_MARKER: marker },
    })
    await expect(runExecutionPlan({
      ...plan([command]),
      preparations: [{ ...command, id: 'prepare:project', cwd: path.join(root, 'missing'), beforeTask: command.id }],
    })).rejects.toThrow('ENOENT')
    expect(existsSync(marker)).toBe(false)
    expect(summary()).toContain('preparation, project project')
    expect(summary()).toContain('app:target:test: not run')
  })

  it.each(['SIGINT', 'SIGTERM'] as const)('never starts a command cancelled during its cwd check (%s)', async (signal) => {
    const cwd = await temporaryDirectory('matrix-exec-cwd-cancel-')
    const marker = path.join(cwd, 'unexpected-command')
    const command = scriptedTask('app:target:test', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "ran")', {
      cwd,
      env: { MATRIX_TEST_MARKER: marker },
    })
    const listeners = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') }
    const check = holdDirectoryCheck(cwd)
    const execution = runExecutionPlan(plan([command]), undefined, check.release)
    await check.entered
    process.emit(signal)
    check.release()
    const result = await execution
    // On regression, wait for the real escaped child before checking its side effect.
    await Promise.allSettled([...result.children.values()].map(child => child.result))
    expect(existsSync(marker)).toBe(false)
    expect(result.children.size).toBe(0)
    expect(result.cancelled).toBe(signal)
    expect(summary()).toContain(`Execution cancelled (${signal})`)
    expect(summary()).toContain('app:target:test: cancelled')
    expect(summary()).not.toContain('Failure:')
    expect(process.listenerCount('SIGINT')).toBe(listeners.SIGINT)
    expect(process.listenerCount('SIGTERM')).toBe(listeners.SIGTERM)
  })

  it('does not start a command when a service aborts execution during its cwd check', async () => {
    const cwd = await temporaryDirectory('matrix-exec-cwd-service-')
    const targetRoot = path.join(cwd, 'target')
    await fs.mkdir(targetRoot)
    const ready = path.join(cwd, 'ready.pid')
    const exit = path.join(cwd, 'exit')
    const marker = path.join(cwd, 'unexpected-command')
    const service = scriptedTask('app:service:test', [
      'const fs = require("node:fs")',
      'fs.watch(process.cwd(), () => { if (fs.existsSync(process.env.MATRIX_TEST_EXIT)) process.exit(9) })',
      'fs.writeFileSync(process.env.MATRIX_TEST_READY, String(process.pid))',
    ].join('\n'), { cwd, continuous: true, env: { MATRIX_TEST_READY: ready, MATRIX_TEST_EXIT: exit } })
    const target = scriptedTask('app:target:test', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "ran")', {
      cwd: targetRoot,
      env: { MATRIX_TEST_MARKER: marker },
    })
    const listeners = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') }
    const check = holdDirectoryCheck(targetRoot)
    let targetSignal!: AbortSignal
    const execution = runExecutionPlan(plan([service, target]), {
      preparation: {
        cwd,
        prepare: async (task, _run, signal) => {
          if (task?.id === target.id)
            targetSignal = signal
        },
      },
    }, check.release)
    void execution.catch(() => undefined)
    await check.entered
    const aborted = new Promise<void>(resolve => targetSignal.addEventListener('abort', () => resolve(), { once: true }))
    await waitForFile(ready)
    await fs.writeFile(exit, '')
    await aborted
    check.release()
    await expect(execution).rejects.toThrow('app:service:test exited with code 9')
    expect(existsSync(marker)).toBe(false)
    expect(messages).not.toContain('app:target:test [1/1]')
    expect(summary()).toContain('app:service:test: failed')
    expect(process.listenerCount('SIGINT')).toBe(listeners.SIGINT)
    expect(process.listenerCount('SIGTERM')).toBe(listeners.SIGTERM)
  })

  it('identifies artifact failures and does not complete a task whose artifact was not delivered', async () => {
    const cwd = await temporaryDirectory('matrix-exec-missing-artifact-')
    const missing = scriptedTask('app:web:build', 'process.exit(0)', {
      cwd,
      projectRoot: cwd,
      outputDir: path.join(cwd, 'missing'),
      artifacts: { mode: 'archive', format: 'zip', clean: false },
    })
    await expect(runExecutionPlan(plan([missing, scriptedTask('app:next:test', 'process.exit(0)')])))
      .rejects
      .toThrow('Artifact source directory does not exist')
    expect(summary()).toContain('app:web:build: failed')
    expect(summary()).toContain('artifact handling, project project')
    expect(summary()).toContain('app:next:test: not run')
    expect(summary()).not.toContain('Artifact:')
    expect(summary()).toContain(missing.outputDir)
  })

  it('identifies a failed continuous task while waiting only for services', async () => {
    const cwd = await temporaryDirectory('matrix-exec-service-steps-')
    const marker = path.join(cwd, 'second-step-started')
    const service = scriptedTask('app:service:test', 'setTimeout(() => process.exit(9), 50)', { continuous: true, cwd })
    service.command = [scriptCommand, 'echo started > second-step-started']
    await expect(runExecutionPlan(plan([service]))).rejects.toThrow('app:service:test exited with code 9')
    expect(summary()).toContain('app:service:test: failed')
    expect(summary()).toContain('command, project project, step 1/2')
    expect(summary().split('Failure:')).toHaveLength(2)
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32').each(['target', 'prepare', 'ready', 'service'])('force-stops a stubborn child during %s cancellation (POSIX)', async (phase) => {
    const cwd = await temporaryDirectory('matrix-exec-stubborn-')
    const ready = path.join(cwd, 'ready.pid')
    const marker = path.join(cwd, 'next-started')
    const listeners = process.listenerCount('SIGINT')
    const continuous = phase === 'ready' || phase === 'service'
    const runningTask = scriptedTask('app:running:test', [
      'const fs = require("node:fs")',
      'process.on("SIGTERM", () => {})',
      'setInterval(() => {}, 1000)',
      'fs.writeFileSync(process.env.MATRIX_TEST_READY, String(process.pid))',
    ].join(String.fromCharCode(10)), {
      continuous,
      env: { MATRIX_TEST_READY: ready },
      ...(phase === 'ready' ? { readyWhen: { type: 'port' as const, port: await freePort(), timeout: 60_000 } } : {}),
    })
    const next = scriptedTask('app:next:test', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "started")', {
      env: { MATRIX_TEST_MARKER: marker },
      ...(phase === 'ready' ? { dependsOn: [{ id: runningTask.id, condition: 'ready' as const }] } : {}),
    })
    const executionPlan = phase === 'prepare'
      ? { ...plan([next]), preparations: [{ id: 'prepare:project', project: 'project', command: runningTask.command, cwd, env: runningTask.env, beforeTask: next.id }] }
      : plan(phase === 'service' ? [runningTask] : [runningTask, next])
    let completed = false
    let pid: number | undefined
    const execution = runExecutionPlan(executionPlan, undefined, () => {
      vi.useRealTimers()
      // A test failure can abandon fake time before the production grace
      // deadline. Its owner still has to release this deliberately stubborn PID.
      if (pid && processExists(pid))
        process.kill(pid, 'SIGKILL')
    }).then((result) => {
      completed = true
      return result
    })
    // Keep failures handled until the assertion below observes the execution.
    void execution.catch(() => undefined)
    await waitForFile(ready)
    pid = Number(await fs.readFile(ready, 'utf8'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    process.emit('SIGINT')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(completed).toBe(false)
    expect(processExists(pid!)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 1000 })
    vi.useRealTimers()
    expect((await execution).cancelled).toBe('SIGINT')
    expect(summary()).toContain('Execution cancelled (SIGINT)')
    await expectProcessStopped(pid!)
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })

  it('cancels execution, terminates the child, and never starts the next task on every platform', async () => {
    const cwd = await temporaryDirectory('matrix-exec-cancel-')
    const ready = path.join(cwd, 'ready.pid')
    const nextMarker = path.join(cwd, 'next-started')
    const running = scriptedTask('app:running:test', [
      'require("node:fs").writeFileSync(process.env.MATRIX_TEST_READY, String(process.pid))',
      'setInterval(() => {}, 1000)',
    ].join(String.fromCharCode(10)), { env: { MATRIX_TEST_READY: ready } })
    const next = scriptedTask('app:next:test', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "started")', { env: { MATRIX_TEST_MARKER: nextMarker } })
    const execution = runExecutionPlan(plan([running, next]))
    await waitForFile(ready)
    const pid = Number(await fs.readFile(ready, 'utf8'))
    process.emit('SIGINT')
    expect((await execution).cancelled).toBe('SIGINT')
    await expectProcessStopped(pid)
    await expect(fs.stat(nextMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(summary()).toContain('app:running:test: cancelled')
    expect(summary()).toContain('app:next:test: not run')
    expect(summary()).not.toContain('Failure:')
  })

  it.skipIf(process.platform === 'win32')('waits for all task groups to exit before reporting a process inspection failure', async () => {
    const cwd = await temporaryDirectory('matrix-exec-inspection-')
    const files = ['first.pid', 'second.pid'].map(name => path.join(cwd, name))
    const tasks = files.map((file, index) => scriptedTask(`app:service${index}:test`, [
      'process.on("SIGTERM", () => {})',
      'setInterval(() => {}, 1000)',
      'require("node:fs").writeFileSync(process.env.MATRIX_TEST_READY, String(process.pid))',
    ].join(String.fromCharCode(10)), { continuous: true, env: { MATRIX_TEST_READY: file } }))
    const listeners = process.listenerCount('SIGINT')
    const execution = runExecutionPlan(plan(tasks))
    void execution.catch(() => undefined)
    await Promise.all(files.map(file => waitForFile(file)))
    const pids = await Promise.all(files.map(async file => Number(await fs.readFile(file, 'utf8'))))
    for (const pid of pids)
      expect(pid).toBeGreaterThan(0)
    vi.stubEnv('PATH', cwd) // No ps binary: exercise the real spawn failure boundary.
    process.emit('SIGINT')
    await expect(execution).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'Execution cancelled' }), expect.objectContaining({ code: 'ENOENT' }), expect.objectContaining({ code: 'ENOENT' })],
    })
    // No retry here: failure must not be reported before cleanup has finished.
    for (const pid of pids)
      expect(processExists(pid)).toBe(false)
    expect(process.listenerCount('SIGINT')).toBe(listeners)
    expect(summary()).toContain('Execution failed (SIGINT)')
    expect(summary()).toContain('cleanup [cleanup]')
    expect(summary()).toContain('ENOENT')
  })

  it.skipIf(process.platform === 'win32')('preserves a nonzero command result when its process-tree cleanup also fails', async () => {
    const cwd = await temporaryDirectory('matrix-exec-double-failure-')
    const ready = path.join(cwd, 'ready')
    const proceed = path.join(cwd, 'proceed')
    const command = scriptedTask('app:failed:build', `
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.env.MATRIX_TEST_READY, String(child.pid));
      setInterval(() => { if (fs.existsSync(process.env.MATRIX_TEST_PROCEED)) process.exit(7); }, 10);
    `, { env: { MATRIX_TEST_READY: ready, MATRIX_TEST_PROCEED: proceed } })
    const execution = runExecutionPlan(plan([command]))
    void execution.catch(() => undefined)
    await waitForFile(ready)
    vi.stubEnv('PATH', cwd)
    await fs.writeFile(proceed, '')
    const error = await execution.catch(error => error)
    expect(error.message).toContain('exited with code 7')
    expect(error.message).toContain('ENOENT')
    const pid = Number(await fs.readFile(ready, 'utf8'))
    expect(processExists(pid)).toBe(false)
  })

  it.skipIf(process.platform === 'win32').each([1, 2])('reports cancellation only after all %i children finish graceful shutdown', async (count) => {
    const cwd = await temporaryDirectory('matrix-exec-shutdown-')
    const markers = Array.from({ length: count }, (_, index) => path.join(cwd, `cleanup-${index}`))
    let reportedAfterCleanup = false
    vi.mocked(consola.info).mockImplementation((message) => {
      messages.push(String(message))
      if (String(message).startsWith('Execution '))
        reportedAfterCleanup = markers.every(marker => existsSync(marker))
    })
    const tasks = markers.map((marker, index) => scriptedTask(`app:running${index}:test`, [
      'const fs = require("node:fs")',
      'process.on("SIGTERM", () => setTimeout(() => { fs.writeFileSync(process.env.MATRIX_TEST_MARKER, "done"); process.exit(0) }, 100))',
      'fs.writeFileSync(process.env.MATRIX_TEST_READY, "ready")',
      'setInterval(() => {}, 1000)',
    ].join('\n'), {
      continuous: count > 1,
      env: { MATRIX_TEST_MARKER: marker, MATRIX_TEST_READY: `${marker}.ready` },
    }))
    const execution = runExecutionPlan(plan(tasks))
    void execution.catch(() => undefined)
    await Promise.all(markers.map(marker => waitForFile(`${marker}.ready`)))
    process.emit('SIGINT')
    expect((await execution).cancelled).toBe('SIGINT')
    for (const marker of markers)
      await expect(fs.readFile(marker, 'utf8')).resolves.toBe('done')
    expect(reportedAfterCleanup).toBe(true)
    for (const task of tasks)
      expect(summary()).toContain(`${task.id}: ${task.continuous ? 'stopped' : 'cancelled'}`)
  })

  it('terminates descendants started through a shell command', async () => {
    const cwd = await temporaryDirectory('matrix-exec-descendants-')
    const ready = path.join(cwd, 'descendant.pid')
    const descendant = `
      require('node:fs').writeFileSync(process.env.MATRIX_TEST_READY, String(process.pid));
      setInterval(() => {}, 1000);
    `
    const running = scriptedTask('app:running:test', `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore', env: process.env });
      setInterval(() => {}, 1000);
    `, { env: { MATRIX_TEST_READY: ready } })
    const execution = runExecutionPlan(plan([running]))
    void execution.catch(() => undefined)
    await waitForFile(ready)
    const pid = Number(await fs.readFile(ready, 'utf8'))
    expect(processExists(pid)).toBe(true)
    process.emit('SIGINT')
    await execution
    // Check the actual consumer, rather than sleeping past a delayed side effect.
    await expectProcessStopped(pid)
  })

  it('cleans stale output before execution and keeps the current archived output', async () => {
    const root = await temporaryDirectory('matrix-exec-artifact-')
    const output = path.join(root, 'dist')
    const artifactsRoot = path.join(root, 'artifacts')
    const freshOutput = path.join(output, 'index.html')
    const staleOutput = path.join(output, 'stale.txt')
    await fs.mkdir(output)
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
    await fs.writeFile(staleOutput, 'stale')
    const build = scriptedTask('app:web:build', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "fresh")', {
      cwd: root,
      projectRoot: root,
      outputDir: output,
      env: { MATRIX_TEST_MARKER: freshOutput },
      artifacts: { mode: 'archive', format: 'zip', clean: true },
    })

    await runExecutionPlan({ ...plan([build]), artifactsRoot })

    await expect(fs.stat(staleOutput)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(freshOutput, 'utf8')).resolves.toBe('fresh')
    await expect(fs.readdir(path.join(artifactsRoot, 'app', 'development'))).resolves.toHaveLength(1)
    expect(summary()).toMatch(/^Execution succeeded.*\s\d+(?:\.\d+)?\s*s\b/)
    expect(summary()).toContain('app:web:build: completed')
    const [artifact] = await fs.readdir(path.join(artifactsRoot, 'app', 'development'))
    expect(summary()).toContain(`Artifact: ${path.join(artifactsRoot, 'app', 'development', artifact!)}`)
  })

  it('inherits the host environment and lets task variables override it', async () => {
    const cwd = await temporaryDirectory('matrix-exec-')
    const marker = path.join(cwd, 'env.json')
    const inheritedKey = 'MATRIX_TEST_HOST_INHERITED'
    const overriddenKey = 'MATRIX_TEST_HOST_OVERRIDDEN'
    vi.stubEnv(inheritedKey, 'host-value')
    vi.stubEnv(overriddenKey, 'host-value')
    const task = scriptedTask('app:environment:test', [
      'const fs = require("node:fs")',
      `fs.writeFileSync(process.env.MATRIX_TEST_MARKER, JSON.stringify({ inherited: process.env.${inheritedKey}, overridden: process.env.${overriddenKey} }))`,
    ].join(String.fromCharCode(10)), {
      env: {
        MATRIX_TEST_MARKER: marker,
        [overriddenKey]: 'task-value',
      },
    })

    await runExecutionPlan(plan([task]))

    await expect(fs.readFile(marker, 'utf8')).resolves.toBe(JSON.stringify({ inherited: 'host-value', overridden: 'task-value' }))
  })

  it('waits for completed dependencies before starting the dependent task', async () => {
    const cwd = await temporaryDirectory('matrix-exec-')
    const marker = path.join(cwd, 'marker')
    const dependency = scriptedTask('app:dependency:test', [
      'const fs = require("node:fs")',
      'setTimeout(() => fs.appendFileSync(process.env.MATRIX_TEST_MARKER, "dependency" + String.fromCharCode(10)), 50)',
    ].join(String.fromCharCode(10)), { env: { MATRIX_TEST_MARKER: marker } })
    const dependent = scriptedTask('app:dependent:test', [
      'require("node:fs").appendFileSync(process.env.MATRIX_TEST_MARKER, "dependent" + String.fromCharCode(10))',
    ].join(String.fromCharCode(10)), {
      env: { MATRIX_TEST_MARKER: marker },
      dependsOn: [{ id: dependency.id, condition: 'completed' }],
    })

    await runExecutionPlan(plan([dependency, dependent]))

    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('dependency\ndependent\n')
  })

  it('does not start dependents when a completed dependency fails', async () => {
    const cwd = await temporaryDirectory('matrix-exec-')
    const marker = path.join(cwd, 'marker')
    const dependency = scriptedTask('app:dependency:test', 'process.exit(7)')
    const dependent = scriptedTask('app:dependent:test', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "started")', {
      env: { MATRIX_TEST_MARKER: marker },
      dependsOn: [{ id: dependency.id, condition: 'completed' }],
    })

    await expect(runExecutionPlan(plan([dependency, dependent])))
      .rejects
      .toThrow('app:dependency:test exited with code 7')
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(summary()).toContain('app:dependency:test: failed')
    expect(summary()).toContain('app:dependent:test: not run')
    expect(summary()).toContain('command, project project, step 1/1')
  })

  it('waits for a port before starting a ready dependent', async () => {
    const cwd = await temporaryDirectory('matrix-exec-')
    const marker = path.join(cwd, 'marker')
    const port = await freePort()
    const service = scriptedTask('app:service:test', [
      'const net = require("node:net")',
      'const server = net.createServer()',
      'server.listen(Number(process.env.MATRIX_TEST_PORT), "127.0.0.1")',
      'const check = setInterval(() => { if (require("node:fs").existsSync(process.env.MATRIX_TEST_MARKER)) { clearInterval(check); server.close(() => process.exit(0)) } }, 10)',
    ].join(String.fromCharCode(10)), {
      continuous: true,
      env: { MATRIX_TEST_PORT: port, MATRIX_TEST_MARKER: marker },
      readyWhen: { type: 'port', host: '127.0.0.1', port, timeout: fixtureReadyTimeout },
    })
    const dependent = scriptedTask('app:dependent:test', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "started")', {
      env: { MATRIX_TEST_MARKER: marker },
      dependsOn: [{ id: service.id, condition: 'ready' }],
    })

    await runExecutionPlan(plan([service, dependent]))

    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('started')
    expect(summary()).toContain('app:service:test: stopped')
    expect(summary()).toContain('app:dependent:test: completed')
  })

  it('fails when a ready dependency exits before becoming ready', async () => {
    const port = await freePort()
    const service = scriptedTask('app:service:test', 'setTimeout(() => process.exit(0), 150)', {
      continuous: true,
      readyWhen: { type: 'port', host: '127.0.0.1', port, timeout: fixtureReadyTimeout },
    })
    const dependent = scriptedTask('app:dependent:test', 'process.exit(0)', {
      dependsOn: [{ id: service.id, condition: 'ready' }],
    })

    await expect(runExecutionPlan(plan([service, dependent])))
      .rejects
      .toThrow('app:service:test exited before becoming ready')
    expect(summary()).toContain('app:service:test: failed')
    expect(summary()).toContain('app:dependent:test: not run')
    expect(summary()).toContain('readiness, project project, affected task app:dependent:test')
  })

  it('honors a short readiness timeout', async () => {
    const port = await freePort()
    const service = scriptedTask('app:service:test', 'setTimeout(() => process.exit(0), 500)', {
      continuous: true,
      readyWhen: { type: 'port', host: '127.0.0.1', port, timeout: 25 },
    })
    const dependent = scriptedTask('app:dependent:test', 'process.exit(0)', {
      dependsOn: [{ id: service.id, condition: 'ready' }],
    })
    await expect(runExecutionPlan(plan([service, dependent])))
      .rejects
      .toThrow('Timed out waiting for')
    expect(summary()).toContain('readiness, project project, affected task app:dependent:test')
    expect(summary()).toContain('app:service:test: failed')
  })

  it('fails fast when an independent continuous task exits unexpectedly', async () => {
    const cwd = await temporaryDirectory('matrix-exec-service-failure-')
    const marker = path.join(cwd, 'long-task-completed')
    const service = scriptedTask('app:service:test', 'setTimeout(() => process.exit(9), 50)', {
      continuous: true,
    })
    const longRunningTask = scriptedTask('app:long-running:test', 'setTimeout(() => require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "done"), 5_000)', { env: { MATRIX_TEST_MARKER: marker } })

    await expect(runExecutionPlan(plan([service, longRunningTask])))
      .rejects
      .toThrow('app:service:test exited with code 9')
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(summary()).toContain('app:service:test: failed')
    expect(summary()).toContain('app:long-running:test: stopped')
    expect(summary().split('Failure:')).toHaveLength(2)
  })
})
