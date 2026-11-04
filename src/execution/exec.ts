import type { ExecutionPlan, ExecutionTask, ProjectPreparation } from '../types.js'
import type { ExecutionPreparation } from './preparation.js'
import type { OwnedProcess, ProcessResult } from './process.js'
import type { FailureContext } from './report.js'
import type { ResourceClaim } from './session.js'
import { mkdir, rm, stat } from 'node:fs/promises'
import net from 'node:net'
import process from 'node:process'
import consola from 'consola'
import path from 'pathe'
import { MATRIX_ENV_SCHEMA_KEY, MATRIX_TYPE_CONTRACT_KEY, serializeEnvSchema } from '../config/env-schema.js'
import { ProjectTypePreparationError } from '../typegen/project.js'
import { assertSafeOutputDirectory } from '../utils/output.js'
import { resolveFilesystemPath } from '../utils/path.js'
import { materializeArtifact } from './artifact.js'
import { startProcess } from './process.js'
import { ExecutionFailure, ExecutionReport } from './report.js'
import { ExecutionSession } from './session.js'

type Child = OwnedProcess
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

async function waitReady(completion: Promise<ProcessResult>, task: ExecutionTask, interruptions: Set<Promise<never>>): Promise<void> {
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
      completion,
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
export async function runExecutionPlan(plan: ExecutionPlan, options: { report?: ExecutionReport, preparation?: ExecutionPreparation } = {}): Promise<{ children: Map<string, Child>, cancelled: false | 'SIGINT' | 'SIGTERM' }> {
  for (const task of [...plan.tasks, ...(plan.preparations ?? [])])
    delete task.env[MATRIX_TYPE_CONTRACT_KEY]
  const report = options.report ?? new ExecutionReport(plan)
  const session = new ExecutionSession()
  const cancellationError = new Error('Execution cancelled')
  let interruptWaits!: () => void
  const cancellation = new Promise<never>((_, reject) => {
    interruptWaits = () => reject(cancellationError)
  })
  // Cancellation can arrive between waits, so keep the rejection handled.
  void cancellation.catch(() => undefined)
  const interruptions = new Set<Promise<never>>([cancellation])
  let cleanupFailed = false
  const controller = new AbortController()
  let cancelled: false | 'SIGINT' | 'SIGTERM' = false
  const stopAll = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (cancelled)
      return
    cancelled = signal
    report.cancel(signal)
    controller.abort(cancellationError)
    interruptWaits()
    void session.stop()
  }

  const interrupt = (): void => stopAll('SIGINT')
  const terminate = (): void => stopAll('SIGTERM')

  async function inPhase<T>(context: FailureContext, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    }
    catch (error) {
      if (cancelled)
        throw cancellationError
      if (controller.signal.aborted)
        throw controller.signal.reason
      if (error === cancellationError || error instanceof ExecutionFailure)
        throw error
      throw report.fail(error instanceof ProjectTypePreparationError ? { ...context, project: error.project, ...(error.task ? { affectedTask: error.task } : {}) } : context, error)
    }
  }

  async function runCommands(task: Pick<ExecutionTask, 'id' | 'command' | 'cwd' | 'env' | 'project'> & { continuous?: boolean }, context: FailureContext, resources: ResourceClaim[]): Promise<void> {
    const commands = Array.isArray(task.command) ? task.command : [task.command]
    for (const [index, command] of commands.entries()) {
      if (cancelled)
        return
      report.start(task.id)
      const stepContext = { ...context, step: index + 1, steps: commands.length }
      await inPhase(stepContext, async () => {
        // Validate cwd explicitly instead of relying on platform-specific spawn/shell failures.
        const directory = await stat(task.cwd)
        controller.signal.throwIfAborted()
        if (!directory.isDirectory())
          throw new Error(`Execution working directory is not a directory: ${task.cwd}`)
        controller.signal.throwIfAborted()
        consola.info(`${task.id} [${index + 1}/${commands.length}]`)
        const env = {
          ...process.env,
          ...Object.fromEntries(Object.entries(task.env).map(([key, value]) => [key, String(value)])),
          [MATRIX_ENV_SCHEMA_KEY]: serializeEnvSchema(plan.envSchema),
          // Do not inherit another CLI invocation's output handshake.
          [MATRIX_TYPE_CONTRACT_KEY]: task.env[MATRIX_TYPE_CONTRACT_KEY] === undefined ? undefined : String(task.env[MATRIX_TYPE_CONTRACT_KEY]),
        }
        const commandError = (result: { exitCode?: number | undefined, signal?: string | undefined, code?: string | undefined }): Error => {
          if (result.exitCode !== undefined)
            return new Error(`${task.id} exited with code ${result.exitCode}`)
          if (result.signal)
            return new Error(`${task.id} exited with signal ${result.signal}`)
          return new Error(`${task.id} could not execute command${result.code ? ` (${result.code})` : ''}`)
        }
        const running = await session.start(task.id, 'command', resources, (): OwnedProcess => {
          const child = startProcess({ command }, task.cwd, env)
          return {
            ...child,
            result: child.result.then((result) => {
              // Preserve command failure even when the subsequent tree drain fails.
              if (result.exitCode !== 0 && !cancelled && !session.stopping)
                throw commandError(result)
              return result
            }),
          }
        }, controller.signal)

        if (task.continuous) {
          const service = running.completion.then((result) => {
            if (cancelled || session.stopping)
              return
            if (result.exitCode === 0) {
              report.complete(task.id)
              return
            }
            throw report.fail(stepContext, commandError(result))
          }, (error: unknown) => {
            if (cancelled || session.stopping)
              return
            throw report.fail(stepContext, error)
          })
          running.service = service
          const failure = service.then(() => neverSettles)
          interruptions.add(failure)
          // Abort in-flight preparation too, while its caller still awaits cleanup.
          void failure.catch(error => controller.abort(error))
          return
        }

        const result = await raceWithInterruptions(running.completion, interruptions)
        if (cancelled)
          return
        if (result.exitCode !== 0)
          throw commandError(result)
      })
      if (task.continuous)
        return
    }
  }

  async function runPreparation(preparation: ProjectPreparation): Promise<void> {
    // Shared-context preparations are created during execution, after the plan's
    // initial sanitization. Never pass an inherited CLI handshake to user setup.
    delete preparation.env[MATRIX_TYPE_CONTRACT_KEY]
    await runCommands(preparation, { id: preparation.id, phase: 'preparation', project: preparation.project, ...(preparation.beforeTask ? { affectedTask: preparation.beforeTask } : {}) }, [{ path: preparation.cwd, access: 'write' }])
    controller.signal.throwIfAborted()
    report.complete(preparation.id)
  }

  async function prepare(task?: ExecutionTask): Promise<void> {
    if (options.preparation) {
      await inPhase({ id: task?.id ?? 'prepare:types', phase: 'preparation', ...(task ? { project: task.project } : {}) }, () => options.preparation!.prepare(task, runPreparation, controller.signal, session))
      return
    }
    for (const preparation of plan.preparations ?? []) {
      if (preparation.beforeTask !== task?.id)
        continue
      await runPreparation(preparation)
      if (cancelled)
        return
    }
  }

  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  async function execute(): Promise<{ children: Map<string, Child>, cancelled: false | 'SIGINT' | 'SIGTERM' }> {
    if (!plan.tasks.length || !options.preparation)
      await prepare()
    if (cancelled)
      return { children: session.children, cancelled }
    for (const task of plan.tasks) {
      if (cancelled)
        break

      for (const dependency of task.dependsOn) {
        const running = session.command(dependency.id)
        if (!running)
          throw report.fail({ id: task.id, phase: 'readiness' }, new Error(`Dependency ${dependency.id} was not started`))
        if (dependency.condition === 'completed') {
          const result = await inPhase({ id: dependency.id, phase: 'command', affectedTask: task.id }, () => raceWithInterruptions(running.completion, interruptions))
          if (cancelled)
            return { children: session.children, cancelled }
          if (result.exitCode !== 0)
            throw report.fail({ id: dependency.id, phase: 'command', affectedTask: task.id }, new Error(`${dependency.id} exited with code ${result.exitCode}`))
        }
        else {
          const dependencyTask = plan.tasks.find(item => item.id === dependency.id)
          if (!dependencyTask)
            throw report.fail({ id: task.id, phase: 'readiness' }, new Error(`Dependency task ${dependency.id} is missing`))
          await inPhase({ id: dependency.id, phase: 'readiness', project: dependencyTask.project, affectedTask: task.id }, () => waitReady(running.completion, dependencyTask, interruptions))
          if (cancelled)
            return { children: session.children, cancelled }
        }
      }

      if (cancelled)
        break
      const resources: ResourceClaim[] = [
        { path: task.projectRoot, access: 'read' },
        { path: task.cwd, access: 'read' },
        { path: task.outputDir, access: 'write' },
      ]
      if (!task.continuous && task.artifacts?.clean) {
        await inPhase({ id: task.id, phase: 'artifact handling', project: task.project }, async () => {
          await session.use(task.id, [{ path: task.outputDir, access: 'write' }], () => cleanOutputDirectory(task.projectRoot, task.outputDir), controller.signal)
        })
      }

      await prepare(task)
      if (cancelled)
        return { children: session.children, cancelled }

      await runCommands(task, { id: task.id, phase: 'command', project: task.project }, resources)
      if (cancelled)
        return { children: session.children, cancelled }

      if (!task.continuous && task.artifacts) {
        const artifacts = task.artifacts
        const artifactPath = await inPhase({ id: task.id, phase: 'artifact handling', project: task.project }, () => session.use(task.id, [
          { path: task.outputDir, access: 'write' },
          { path: path.join(plan.artifactsRoot, task.product, plan.envName), access: 'write' },
        ], () => materializeArtifact({
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
        }), controller.signal))
        report.artifact(artifactPath)
      }
      if (!task.continuous)
        report.complete(task.id)
    }

    if (cancelled)
      return { children: session.children, cancelled }
    if (session.services.length)
      await raceWithInterruptions(Promise.race(session.services), interruptions)
    return { children: session.children, cancelled }
  }
  try {
    return await session.within(options.preparation?.cwd, execute, controller.signal, (error) => {
      // Cleanup failures retain their native error identity and retain ownership.
      cleanupFailed = true
      report.fail({ id: 'cleanup', phase: 'cleanup' }, error)
    })
  }
  catch (error) {
    if (cleanupFailed)
      throw error
    if (error !== cancellationError)
      throw report.fail({ id: 'execution', phase: 'command' }, error)
    return { children: session.children, cancelled }
  }
  finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
    if (!options.report)
      report.print()
  }
}
