import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { execa } from 'execa'
import { throwFailures, withCleanup } from '../utils/errors.js'

type Child = Promise<unknown> & { pid?: number | undefined }
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

async function discardExitedGroups(groups: Set<number>, signal: AbortSignal): Promise<void> {
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
}

async function waitForGroups(groups: Set<number>, signal: AbortSignal): Promise<void> {
  while (groups.size) {
    await discardExitedGroups(groups, signal)
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
  throwFailures(errors)
}

/** Children own process groups on POSIX (execa killDescendants). Keep inherited TTYs. */
export async function stopProcessGroups(children: Child[]): Promise<void> {
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
    // Normal command completion can leave a group containing only unreaped
    // processes. Establish live consumers before attempting to signal it.
    await discardExitedGroups(groups, controller.signal)
    for (const pid of groups) {
      try {
        signalGroup(pid, 'SIGTERM')
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM')
          throw error
        // The last live member may have exited since inspection. EPERM alone
        // never proves that ownership can be released.
        await discardExitedGroups(groups, controller.signal)
        if (groups.has(pid))
          throw error
      }
    }
    await waitForGroups(groups, controller.signal)
    await Promise.allSettled(children)
  }
  catch (error) {
    clearTimeout(timeout)
    clearTimeout(deadline)
    await withCleanup(() => {
      throw error
    }, () => forceStopGroups(children, groups))
  }
  finally {
    clearTimeout(timeout)
    clearTimeout(deadline)
  }
}
