import type { ExecutionPlan, ExecutionTask } from '../types.js'
import type { FailureContext } from './report.js'
import { mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import process from 'node:process'
import consola from 'consola'
import { execa } from 'execa'
import { MATRIX_ENV_SCHEMA_KEY, serializeEnvSchema } from '../config/env-schema.js'
import { assertSafeOutputDirectory } from '../utils/output.js'
import { resolveFilesystemPath } from '../utils/path.js'
import { materializeArtifact } from './artifact.js'
import { stopProcessTrees } from './process-tree.js'
import { ExecutionFailure, ExecutionReport } from './report.js'

type Child = ReturnType<typeof execa>
const neverSettles: Promise<never> = new Promise(() => undefined)

function raceWithInterruptions<T>(promise: Promise<T>, interruptions: Set<Promise<never>>): Promise<T> {
  return interruptions.size ? Promise.race([promise, ...interruptions]) : promise
}

function canConnect(host: string, port: number, timeout: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const finish = (connected: boolean): void => {
      if (settled)
        return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeout, () => finish(false))
  })
}

async function waitReady(child: Child, task: ExecutionTask, interruptions: Set<Promise<never>>): Promise<void> {
  const readyWhen = task.readyWhen
  if (!readyWhen)
    return

  const timeout = readyWhen.timeout ?? 30_000
  const deadline = Date.now() + timeout
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0)
      break
    if (await raceWithInterruptions(canConnect(readyWhen.host ?? '127.0.0.1', readyWhen.port, Math.min(1_000, remaining)), interruptions))
      return
    const result = await raceWithInterruptions(Promise.race([
      child.then(value => value),
      new Promise<undefined>(resolve => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now())))),
    ]), interruptions)
    if (result !== undefined)
      throw new Error(`${task.id} exited before becoming ready`)
  }
  throw new Error(`Timed out waiting for ${task.id} on port ${readyWhen.port}`)
}

async function cleanOutputDirectory(projectRoot: string, outputDir: string): Promise<void> {
  assertSafeOutputDirectory(projectRoot, outputDir)
  const outputPath = resolveFilesystemPath(outputDir)
  await rm(outputPath, { recursive: true, force: true })
  await mkdir(outputPath, { recursive: true })
}

/** Executes tasks in plan order while respecting dependency readiness conditions. */
export async function runExecutionPlan(plan: ExecutionPlan, options: { report?: ExecutionReport } = {}): Promise<{ children: Map<string, Child>, cancelled: false | 'SIGINT' | 'SIGTERM' }> {
  const report = options.report ?? new ExecutionReport(plan)
  const children = new Map<string, Child>()
  const services = new Map<string, Promise<void>>()
  const stopping = new Set<string>()
  const settled = new Set<Child>()
  const cancellationError = new Error('Execution cancelled')
  let interruptWaits!: () => void
  const cancellation = new Promise<never>((_, reject) => {
    interruptWaits = () => reject(cancellationError)
  })
  // Cancellation can arrive between waits, so keep the rejection handled.
  void cancellation.catch(() => undefined)
  const interruptions = new Set<Promise<never>>([cancellation])
  const prepared = new Set<string>()
  let shutdown: Promise<void> | undefined
  const stopChildren = (): Promise<void> => {
    if (!shutdown) {
      for (const id of children.keys())
        stopping.add(id)
      shutdown = stopProcessTrees([...children.values()], settled)
      // An interrupt can arrive during artifact I/O, before finally awaits shutdown.
      void shutdown.catch(() => undefined)
    }
    return shutdown
  }
  let cancelled: false | 'SIGINT' | 'SIGTERM' = false
  const stopAll = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (cancelled)
      return
    cancelled = signal
    report.cancel(signal)
    interruptWaits()
    void stopChildren()
  }

  const interrupt = (): void => stopAll('SIGINT')
  const terminate = (): void => stopAll('SIGTERM')

  async function inPhase<T>(context: FailureContext, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    }
    catch (error) {
      if (error === cancellationError || error instanceof ExecutionFailure)
        throw error
      throw report.fail(context, error)
    }
  }

  async function runCommands(task: Pick<ExecutionTask, 'id' | 'command' | 'cwd' | 'env' | 'project'> & { continuous?: boolean }, context: FailureContext): Promise<void> {
    const commands = Array.isArray(task.command) ? task.command : [task.command]
    for (const [index, command] of commands.entries()) {
      if (cancelled)
        return
      report.start(task.id)
      const stepContext = { ...context, step: index + 1, steps: commands.length }
      await inPhase(stepContext, async () => {
        consola.info(`${task.id} [${index + 1}/${commands.length}]`)
        const child = execa(command, {
          cwd: task.cwd,
          env: {
            ...Object.fromEntries(Object.entries(task.env).map(([key, value]) => [key, String(value)])),
            [MATRIX_ENV_SCHEMA_KEY]: serializeEnvSchema(plan.envSchema),
          },
          extendEnv: true,
          forceKillAfterDelay: false,
          shell: true,
          stdio: 'inherit',
          reject: false,
          killDescendants: true,
        }) as Child
        stopping.delete(task.id)
        children.set(task.id, child)
        void child.then(() => settled.add(child), () => settled.add(child))

        const commandError = (result: { exitCode?: number | undefined, signal?: string | undefined, code?: string | undefined }): Error => {
          if (result.exitCode !== undefined)
            return new Error(`${task.id} exited with code ${result.exitCode}`)
          if (result.signal)
            return new Error(`${task.id} exited with signal ${result.signal}`)
          return new Error(`${task.id} could not execute command${result.code ? ` (${result.code})` : ''}`)
        }

        if (task.continuous) {
          const service = child.then((result) => {
            if (cancelled || stopping.size)
              return
            if (result.exitCode === 0) {
              report.complete(task.id)
              return
            }
            throw report.fail(stepContext, commandError(result))
          }, (error: unknown) => {
            if (cancelled || stopping.size)
              return
            throw report.fail(stepContext, error)
          })
          services.set(task.id, service)
          const failure = service.then(() => neverSettles)
          interruptions.add(failure)
          void failure.catch(() => undefined)
          return
        }

        const result = await raceWithInterruptions(child, interruptions)
        if (cancelled)
          return
        if (result.exitCode !== 0)
          throw commandError(result)
      })
      if (task.continuous)
        return
    }
  }

  async function prepare(beforeTask?: string): Promise<void> {
    for (const preparation of plan.preparations ?? []) {
      if (preparation.beforeTask !== beforeTask || prepared.has(preparation.project))
        continue
      await runCommands(preparation, { id: preparation.id, phase: 'preparation', project: preparation.project, ...(beforeTask ? { affectedTask: beforeTask } : {}) })
      if (cancelled)
        return
      report.complete(preparation.id)
      prepared.add(preparation.project)
    }
  }

  async function cleanup(): Promise<void> {
    try {
      if (cancelled || plan.tasks.some(task => task.continuous))
        await stopChildren()
      else
        await Promise.allSettled([...children.values()])
    }
    catch (error) {
      // Preserve cleanup's original error contract (including native error codes).
      report.fail({ id: 'cleanup', phase: 'cleanup' }, error)
      throw error
    }
  }

  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    await prepare()
    if (cancelled)
      return { children, cancelled }
    for (const task of plan.tasks) {
      if (cancelled)
        break

      for (const dependency of task.dependsOn) {
        const child = children.get(dependency.id)
        if (!child)
          throw report.fail({ id: task.id, phase: 'readiness' }, new Error(`Dependency ${dependency.id} was not started`))
        if (dependency.condition === 'completed') {
          const result = await inPhase({ id: dependency.id, phase: 'command', affectedTask: task.id }, () => raceWithInterruptions(child, interruptions))
          if (cancelled)
            return { children, cancelled }
          if (result.exitCode !== 0)
            throw report.fail({ id: dependency.id, phase: 'command', affectedTask: task.id }, new Error(`${dependency.id} exited with code ${result.exitCode}`))
        }
        else {
          const dependencyTask = plan.tasks.find(item => item.id === dependency.id)
          if (!dependencyTask)
            throw report.fail({ id: task.id, phase: 'readiness' }, new Error(`Dependency task ${dependency.id} is missing`))
          await inPhase({ id: dependency.id, phase: 'readiness', project: dependencyTask.project, affectedTask: task.id }, () => waitReady(child, dependencyTask, interruptions))
          if (cancelled)
            return { children, cancelled }
        }
      }

      if (cancelled)
        break
      if (!task.continuous && task.artifacts?.clean)
        await inPhase({ id: task.id, phase: 'artifact handling', project: task.project }, () => cleanOutputDirectory(task.projectRoot, task.outputDir))

      await prepare(task.id)
      if (cancelled)
        return { children, cancelled }

      await runCommands(task, { id: task.id, phase: 'command', project: task.project })
      if (cancelled)
        return { children, cancelled }

      if (!task.continuous && task.artifacts) {
        const artifacts = task.artifacts
        const artifactPath = await inPhase({ id: task.id, phase: 'artifact handling', project: task.project }, () => materializeArtifact({
          sourceDir: task.outputDir,
          artifactsRoot: plan.artifactsRoot,
          product: task.product,
          environment: plan.envName,
          variant: task.variant,
          projectRoot: task.projectRoot,
          ...(task.version === undefined ? {} : { version: task.version }),
          mode: artifacts.mode,
          format: artifacts.format,
          retention: plan.artifactRetention,
        }))
        report.artifact(artifactPath)
      }
      if (!task.continuous)
        report.complete(task.id)
    }

    if (cancelled)
      return { children, cancelled }
    if (services.size)
      await raceWithInterruptions(Promise.race(services.values()), interruptions)
    return { children, cancelled }
  }
  catch (error) {
    if (error !== cancellationError)
      throw report.fail({ id: 'execution', phase: 'command' }, error)
    return { children, cancelled }
  }
  finally {
    try {
      await cleanup()
    }
    finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
      if (!options.report)
        report.print()
    }
  }
}
