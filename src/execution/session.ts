import type { OwnedProcess } from './process.js'
import { settleAll, withCleanup } from '../utils/errors.js'
import { containsPath, resolveFuturePath } from '../utils/path.js'
import { withExecutionLock } from './lock.js'
import { disposeProcesses } from './process.js'

type Child = OwnedProcess

export interface ResourceClaim {
  path: string
  access: 'read' | 'write'
}

interface Activity {
  id: string
  kind: 'command' | 'host' | 'operation'
  child?: OwnedProcess<unknown>
  resources: ResourceClaim[]
  state: 'owned' | 'released'
  completion: Promise<unknown>
  cleanup?: Promise<void>
  service?: Promise<void>
  beforeStop?: () => Promise<void>
}

type RunningProcess<T extends OwnedProcess<unknown>> = Omit<Activity, 'child' | 'completion'> & { child: T, completion: T['result'] }
type RunningCommand = RunningProcess<Child>

/**
 * The execution's process and resource owner. Every effect acquires a claim
 * before it starts; release follows operation completion or process-tree drain.
 */
export class ExecutionSession {
  private readonly activities: Activity[] = []
  private shutdown: Promise<void> | undefined

  get stopping(): boolean {
    return this.shutdown !== undefined
  }

  get children(): Map<string, Child> {
    return new Map(this.activities.filter(command => command.kind === 'command').map(command => [command.id, command.child as Child]))
  }

  get services(): Promise<void>[] {
    return this.activities.flatMap(command => command.service && command.state !== 'released' ? [command.service] : [])
  }

  command(id: string): RunningCommand | undefined {
    return [...this.activities].reverse().find(command => command.kind === 'command' && command.id === id) as RunningCommand | undefined
  }

  private async acquire(id: string, kind: Activity['kind'], claims: ResourceClaim[], signal?: AbortSignal): Promise<Activity> {
    const resources = await Promise.all(claims.map(async claim => ({ ...claim, path: await resolveFuturePath(claim.path) })))
    signal?.throwIfAborted()
    if (this.stopping)
      throw new Error('Execution session is stopping')
    const conflict = this.activities.find(command => command.state !== 'released' && command.resources.some(owned =>
      resources.some(resource => (owned.access === 'write' || resource.access === 'write')
        && (containsPath(owned.path, resource.path) || containsPath(resource.path, owned.path)))))
    if (conflict)
      throw new Error(`Cannot acquire resources for ${id} while ${conflict.id} is using the same or an overlapping project directory. Use isolated project roots or stop the running target.`)
    const activity: Activity = { id, kind, resources, state: 'owned', completion: Promise.resolve() }
    this.activities.push(activity)
    return activity
  }

  async start<T extends OwnedProcess<unknown>>(id: string, kind: 'command' | 'host', claims: ResourceClaim[], spawn: () => T, signal?: AbortSignal, beforeStop?: () => Promise<void>): Promise<RunningProcess<T>> {
    const activity = await this.acquire(id, kind, claims, signal)
    // acquire resumes through a microtask: cancellation may have arrived meanwhile.
    try {
      signal?.throwIfAborted()
      if (this.stopping)
        throw new Error('Execution session is stopping')
      activity.child = spawn()
    }
    catch (error) {
      activity.state = 'released'
      throw error
    }
    const command = activity as RunningProcess<T>
    if (beforeStop)
      command.beforeStop = beforeStop
    // A shell's exit is not proof that its process tree released the inputs.
    command.completion = withCleanup(() => command.child.result, () => command.cleanup ?? this.drain([command]))
    void command.completion.catch(() => undefined)
    return command
  }

  async use<T>(id: string, claims: ResourceClaim[], action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const activity = await this.acquire(id, 'operation', claims, signal)
    activity.completion = Promise.resolve().then(async () => {
      try {
        signal?.throwIfAborted()
        if (this.stopping)
          throw new Error('Execution session is stopping')
        return await action()
      }
      finally {
        activity.state = 'released'
      }
    })
    // Action failures belong to their phase; shutdown only waits for release.
    activity.cleanup = activity.completion.then(() => {}, () => {})
    return activity.completion as Promise<T>
  }

  finish(activity: Activity): Promise<void> {
    return activity.cleanup ?? this.drain([activity])
  }

  stop(): Promise<void> {
    this.shutdown ??= (async () => {
      const owned = this.activities.filter(command => command.child && !command.cleanup)
      if (owned.length)
        this.drain(owned)
      // Join any cleanup already started by normal command completion. Never
      // launch a competing cleanup or release the lock while one is still active.
      await settleAll([...new Set(this.activities.map(command => command.cleanup ?? command.completion))].map(cleanup => () => cleanup))
    })()
    void this.shutdown.catch(() => undefined)
    return this.shutdown
  }

  private drain(commands: Activity[]): Promise<void> {
    const cleanup = (async () => {
      // Host protocols may need to close their framework before tree termination.
      await withCleanup(
        () => settleAll(commands.map(command => () => command.beforeStop?.())),
        () => disposeProcesses(commands.map(command => command.child!)),
      )
      for (const command of commands)
        command.state = 'released'
    })()
    for (const command of commands)
      command.cleanup = cleanup
    void cleanup.catch(() => undefined)
    return cleanup
  }

  async within<T>(cwd: string | undefined, action: () => Promise<T>, signal: AbortSignal, onCleanupFailure: (error: unknown) => void): Promise<T> {
    const cleanup = async (): Promise<void> => {
      try {
        await this.stop()
      }
      catch (error) {
        onCleanupFailure(error)
        throw error
      }
    }
    const execute = (confirmStopped: () => void): Promise<T> => withCleanup(
      action,
      async () => {
        await cleanup()
        confirmStopped()
      },
    )
    if (!cwd)
      return execute(() => {})
    return withExecutionLock(cwd, async (lease) => {
      // Persist uncertainty before any user command or host configuration can
      // spawn a process. A killed coordinator cannot certify those consumers.
      await lease.markExecuting()
      return execute(() => lease.confirmStopped())
    }, signal)
  }
}
