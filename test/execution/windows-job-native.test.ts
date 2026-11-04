import { access, readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { execa } from 'execa'
import path from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessChannel } from '../../src/execution/channel.js'
import { startProcess } from '../../src/execution/process.js'
import { windowsJobScript } from '../../src/execution/windows-job-script.js'
import { quoteWindowsArgument, startWindowsJob } from '../../src/execution/windows-job.js'
import { withCleanup } from '../../src/utils/errors.js'
import { processExists as alive, releaseRecordedProcesses } from '../helpers/process-fixture.js'
import { releaseResources, testResources } from '../helpers/test-resources.js'

const systemRoot = process.env.SystemRoot ?? process.env.windir ?? ''
const powershell = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')

function command(...args: string[]): string {
  return [process.execPath, ...args].map(quoteWindowsArgument).join(' ')
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Native owner operation did not settle')), 15_000)
      }),
    ])
  }
  finally {
    clearTimeout(timeout)
  }
}

async function releaseNativeOwner(owner: Promise<unknown> & { kill: (signal: 'SIGKILL') => unknown }, pidFile: string): Promise<void> {
  const stopping = (async () => {
    owner.kill('SIGKILL')
    await bounded(owner)
  })()
  await releaseResources([
    () => stopping,
    async () => {
      // Preserve ordering without making PID recovery conditional on success.
      // releaseResources retains the supervisor failure independently.
      await stopping.catch(() => undefined)
      await releaseRecordedProcesses([pidFile])
    },
  ])
}

async function nativeOwner(resources: Awaited<ReturnType<typeof testResources>>, script: string, pidFile: string, env = {}) {
  const channel = await resources.acquire(createProcessChannel, channel => channel.close())
  const { owner } = await resources.acquire(() => ({
    owner: execa(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, channel.name], {
      env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'inherit',
      reject: false,
      windowsHide: true,
    }),
  }), ({ owner }) => releaseNativeOwner(owner, pidFile))
  return {
    channel,
    owner,
    async launch(commandLine: string) {
      const socket = await resources.wait(bounded(Promise.race([
        channel.connected,
        owner.then((result) => { throw new Error(`Owner exited before connecting: ${result.exitCode}`) }),
      ])))
      socket.on('error', () => {})
      socket.write(`${JSON.stringify({ application: process.execPath, command: commandLine, cwd: resources.root })}\n`)
    },
  }
}

describe('native fixture cleanup failures', () => {
  afterEach(() => {
    // A timed-out test function may never reach its own finally.
    vi.useRealTimers()
  })

  it.for(['kill', 'timeout', 'assertion'])('recovers the recorded PID after %s failure', { timeout: 45_000 }, async (failure, ctx) => {
    const resources = await testResources(ctx.signal, 'matrix-owner-failure-')
    const { root } = resources
    const pidFile = path.join(root, 'pid')
    const child = await resources.acquire(() => startProcess({
      file: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync("pid", String(process.pid)); setInterval(() => {}, 1000)'],
    }, root, process.env, 'ignore'), child => child.dispose())
    const pid = await resources.poll(async () => {
      const value = Number(await readFile(pidFile, 'utf8'))
      expect(value).toBeGreaterThan(0)
      return value
    })
    const killError = new Error(failure === 'assertion' ? 'Fixture assertion failed' : 'Supervisor termination denied')
    const owner = Object.assign(failure === 'timeout' ? new Promise<void>(() => {}) : Promise.resolve(), {
      kill: () => {
        if (failure === 'kill')
          throw killError
      },
    })
    vi.useFakeTimers()
    const outcome = (failure === 'assertion'
      ? withCleanup(() => { throw killError }, () => releaseRecordedProcesses([pidFile]))
      : releaseNativeOwner(owner, pidFile)).catch(error => error)
    if (failure === 'timeout')
      await vi.advanceTimersByTimeAsync(15_000)
    vi.useRealTimers()
    const error = await outcome
    if (failure !== 'timeout')
      expect(error).toBe(killError)
    else
      expect(error.message).toBe('Native owner operation did not settle')
    expect(alive(pid)).toBe(false)
    await resources.wait(child.result)
  })
})

describe.skipIf(process.platform !== 'win32')('native Windows job ownership', () => {
  it('runs shell commands with quoted arguments in a Unicode directory', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix shell 中文 ')
    const { root } = resources
    await writeFile(path.join(root, 'entry script.mjs'), `
      import { appendFileSync } from 'node:fs';
      appendFileSync('observed', JSON.stringify(process.argv.slice(2)) + '\\n');
    `)
    const child = await resources.acquire(() => startProcess({ command: 'node "entry script.mjs" "a & b" && node "entry script.mjs" "second"' }, root, process.env, 'ignore'), child => child.dispose())
    expect((await bounded(child.result)).exitCode).toBe(0)
    expect(await readFile(path.join(root, 'observed'), 'utf8')).toBe('["a & b"]\n["second"]\n')
  }, 45_000)

  it('owns a newly created process even if the supervisor dies before startup resumes', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix 创建窗口 ')
    const { root } = resources
    const created = path.join(root, 'created')
    const ran = path.join(root, 'ran')
    const script = path.join(root, 'owner.ps1')
    // Pause at the real Win32 return boundary, before any subsequent user-space
    // assignment/resume. No production test hook or timing-based kill is needed.
    const boundary = 'root = process.Process;'
    expect(windowsJobScript.split(boundary)).toHaveLength(2)
    await writeFile(script, windowsJobScript.replace(boundary, `${boundary}
      System.IO.File.WriteAllText(System.Environment.GetEnvironmentVariable("MATRIX_TEST_CREATED"), process.Pid.ToString());
      while (System.IO.File.Exists(System.Environment.GetEnvironmentVariable("MATRIX_TEST_CREATED"))) Thread.Sleep(10);
    `))
    const { owner, launch } = await nativeOwner(resources, script, created, { MATRIX_TEST_CREATED: created })
    let pid: number | undefined
    await launch(command('-e', `require('node:fs').writeFileSync(${JSON.stringify(ran)},'unexpected')`))
    await resources.poll(async () => {
      pid = Number(await readFile(created, 'utf8'))
      expect(pid).toBeGreaterThan(0)
    })
    expect(alive(pid!)).toBe(true)
    await expect(access(ran)).rejects.toThrow()
    owner.kill('SIGKILL')
    await resources.wait(bounded(owner))
    await vi.waitFor(() => expect(alive(pid!)).toBe(false), { timeout: 5_000 })
    await expect(access(ran)).rejects.toThrow()
  }, 45_000)

  it('rejects a failed native launch and settles every concurrent disposal', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix failed launch ')
    const { root } = resources
    const invalid = await resources.acquire(() => startWindowsJob(path.join(root, 'missing.exe'), 'missing.exe', root, process.env, 'ignore'), async (child) => {
      // Launch failure intentionally cannot certify a started job. Its expected
      // rejection is asserted below, but the cleanup must still settle.
      await child.dispose().catch(() => undefined)
    })
    // The outer deadline must fail the test, not satisfy the expected native
    // startup rejection.
    expect(await bounded(invalid.result.catch(error => error))).toBeInstanceOf(Error)
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => invalid.dispose()))
    expect(outcomes.every(outcome => outcome.status === 'rejected')).toBe(true)
  }, 45_000)

  it('joins concurrent cancellation during startup without executing user code', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix cancelled launch ')
    const { root } = resources
    const ran = path.join(root, 'ran')
    const { child, first } = await resources.acquire(() => {
      const child = startWindowsJob(process.execPath, command('-e', `require('node:fs').writeFileSync(${JSON.stringify(ran)},'unexpected')`), root, process.env, 'ignore')
      return { child, first: child.dispose() }
    }, ({ child }) => child.dispose())
    const concurrent = Array.from({ length: 8 }, () => child.dispose())
    expect(concurrent.every(disposal => disposal === first)).toBe(true)
    await Promise.all(concurrent)
    await expect(child.result).resolves.toEqual({ signal: 'SIGTERM' })
    await expect(access(ran)).rejects.toThrow()
  }, 30_000)

  it.for(['disconnect', 'crash', 'timeout'])('drains a live process tree after supervisor %s', { timeout: 45_000 }, async (failure, ctx) => {
    const cancellation = new AbortController()
    const resources = await testResources(AbortSignal.any([ctx.signal, cancellation.signal]), 'matrix disconnected owner ')
    const { root } = resources
    const ready = path.join(root, 'ready')
    const script = path.join(root, 'owner.ps1')
    await writeFile(script, windowsJobScript)
    const { channel, owner, launch } = await nativeOwner(resources, script, ready)
    let pid: number | undefined
    await launch(command('-e', `
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`)}], {stdio:'ignore'});
        setInterval(()=>{},1000);
      `))
    await resources.poll(async () => {
      pid = Number(await readFile(ready, 'utf8'))
      expect(pid).toBeGreaterThan(0)
    })
    if (failure === 'timeout') {
      const pending = resources.wait(owner)
      cancellation.abort(new Error('test timeout'))
      await expect(pending).rejects.toBe(cancellation.signal.reason)
      await resources.dispose()
    }
    else if (failure === 'crash') {
      owner.kill('SIGKILL')
      await resources.wait(bounded(owner))
    }
    else {
      await channel.close()
      await resources.wait(bounded(owner))
    }
    await vi.waitFor(() => expect(alive(pid!)).toBe(false), { timeout: 5_000 })
  })

  it('repeatedly cancels running jobs without leaving children', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix 重复取消 ')
    const { root } = resources
    const ownerResources = () => process.getActiveResourcesInfo().filter(type => /^(?:Pipe(?:Server)?Wrap|ProcessWrap)$/.test(type)).length
    const initialResources = ownerResources()
    for (let index = 0; index < 8; index++) {
      const ready = path.join(root, `ready-${index}`)
      const child = await resources.acquire(() => startWindowsJob(process.execPath, command('-e', `
        require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));
        setInterval(()=>{},1000);
      `), root, process.env, 'ignore'), child => child.dispose())
      void child.result.catch(() => undefined)
      let pid: number | undefined
      try {
        await resources.poll(async () => {
          pid = Number(await readFile(ready, 'utf8'))
          expect(pid).toBeGreaterThan(0)
        })
        const first = child.dispose()
        const concurrent = Array.from({ length: 8 }, () => child.dispose())
        expect(concurrent.every(disposal => disposal === first)).toBe(true)
        await Promise.all(concurrent)
        await child.result
        expect(alive(pid!)).toBe(false)
        // Give pipe-close/error callbacks a turn before starting the next owner.
        await delay(0)
        await vi.waitFor(() => expect(ownerResources()).toBeLessThanOrEqual(initialResources), { timeout: 5_000 })
      }
      finally {
        await child.dispose().catch(() => undefined)
        if (pid && alive(pid))
          process.kill(pid, 'SIGKILL')
      }
    }
  }, 90_000)
})
