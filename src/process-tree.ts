import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { execa } from 'execa'

type Child = ReturnType<typeof execa>
const shutdownGracePeriod = 30_000

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    // A permission error is not evidence that the process/group has disappeared.
    if ((error as NodeJS.ErrnoException).code === 'EPERM')
      return true
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      throw error
    return false
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      throw error
  }
}

async function waitForGroups(groups: Set<number>, signal: AbortSignal): Promise<void> {
  while (groups.size) {
    for (const pid of groups) {
      if (!exists(-pid))
        groups.delete(pid)
    }
    if (!groups.size)
      return
    // Shell exit does not imply descendant exit. Zombies cannot execute cleanup
    // and only their new parent can reap them, so they must not hold shutdown open.
    const { stdout } = await execa('ps', ['-A', '-o', 'pgid=,stat='], { cancelSignal: signal, timeout: 2_000 })
    const live = new Set(stdout.trim().split(String.fromCharCode(10)).flatMap((line) => {
      const [group, state] = line.trim().split(/ +/)
      return state && !state.startsWith('Z') ? [Number(group)] : []
    }))
    for (const pid of groups) {
      if (!live.has(pid))
        groups.delete(pid)
    }
    if (groups.size)
      await delay(25, undefined, { signal })
  }
}

async function forceStopGroups(children: Child[], groups: Set<number>): Promise<void> {
  const errors: unknown[] = []
  for (const pid of groups) {
    try {
      signalGroup(pid, 'SIGKILL')
    }
    catch (error) {
      errors.push(error)
    }
  }
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        await Promise.allSettled(children)
        // Inspection already failed: use the kernel rather than invoking ps again.
        // If orphan zombies cannot be reaped promptly, report incomplete cleanup.
        while (groups.size) {
          for (const pid of groups) {
            if (!exists(-pid))
              groups.delete(pid)
          }
          if (groups.size)
            await delay(25, undefined, { signal: controller.signal })
        }
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for forced process-tree shutdown')), 5_000)
      }),
    ])
  }
  catch (error) {
    errors.push(error)
  }
  finally {
    clearTimeout(timeout)
    controller.abort()
  }
  if (errors.length)
    throw new AggregateError(errors, 'Process-tree cleanup failed')
}

/** Children own process groups on POSIX (execa killDescendants). Keep inherited TTYs. */
export async function stopProcessTrees(children: Child[], settled: Set<Child>): Promise<void> {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.windir
    if (!systemRoot || !path.win32.isAbsolute(systemRoot))
      throw new Error('Cannot terminate process trees without a Windows system directory')
    const terminations = await Promise.allSettled(children.map(async (child) => {
      if (!child.pid || settled.has(child))
        return
      // Await taskkill itself, not only the shell it terminates.
      const result = await execa(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { reject: false, timeout: 10_000 })
      if (result.failed && exists(child.pid))
        throw new Error(`Unable to terminate process tree ${child.pid}: ${result.stderr}`)
    }))
    const errors = terminations.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(children),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Timed out waiting for Windows process-tree shutdown')), 5_000)
        }),
      ])
    }
    catch (error) {
      errors.push(error)
    }
    finally {
      clearTimeout(timeout)
    }
    if (errors.length)
      throw new AggregateError(errors, 'Windows process-tree cleanup failed')
    return
  }

  const groups = new Set(children.flatMap(child => child.pid && exists(-child.pid) ? [child.pid] : []))
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    try {
      for (const pid of groups)
        signalGroup(pid, 'SIGKILL')
    }
    catch (error) {
      controller.abort(error)
    }
  }, shutdownGracePeriod)
  const deadline = setTimeout(() => controller.abort(), shutdownGracePeriod + 5_000)
  try {
    for (const pid of groups)
      signalGroup(pid, 'SIGTERM')
    await waitForGroups(groups, controller.signal)
    await Promise.allSettled(children)
  }
  catch (error) {
    clearTimeout(timeout)
    clearTimeout(deadline)
    try {
      await forceStopGroups(children, groups)
    }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Process-tree shutdown failed', { cause: error })
    }
    throw error
  }
  finally {
    clearTimeout(timeout)
    clearTimeout(deadline)
  }
}
