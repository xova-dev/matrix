import type { ExecutionPlan, ExecutionTask } from './types.js'
import { mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import consola from 'consola'
import { execa } from 'execa'
import { materializeArtifact } from './artifact.js'
import { stopProcessTrees } from './process-tree.js'

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
  const projectPath = path.resolve(projectRoot)
  const outputPath = path.resolve(outputDir)
  if (outputPath === projectPath || projectPath.startsWith(`${outputPath}${path.sep}`))
    throw new Error(`Refusing to clean an unsafe output directory: ${outputDir}`)
  await rm(outputPath, { recursive: true, force: true })
  await mkdir(outputPath, { recursive: true })
}

/** Executes tasks in plan order while respecting dependency readiness conditions. */
export async function runExecutionPlan(plan: ExecutionPlan): Promise<{ children: Map<string, Child>, cancelled: false | 'SIGINT' | 'SIGTERM' }> {
  const children = new Map<string, Child>()
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
    interruptWaits()
    void stopChildren()
  }

  const interrupt = (): void => stopAll('SIGINT')
  const terminate = (): void => stopAll('SIGTERM')

  async function runCommands(task: Pick<ExecutionTask, 'id' | 'command' | 'cwd' | 'env'> & { continuous?: boolean }): Promise<void> {
    const commands = Array.isArray(task.command) ? task.command : [task.command]
    for (const [index, command] of commands.entries()) {
      if (cancelled)
        return
      consola.info(`${task.id} [${index + 1}/${commands.length}] → ${command}`)
      const child = execa(command, {
        cwd: task.cwd,
        env: Object.fromEntries(Object.entries(task.env).map(([key, value]) => [key, String(value)])),
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

      if (task.continuous) {
        const failure = child.then((result) => {
          if (cancelled || stopping.size || result.exitCode === 0)
            return neverSettles
          throw new Error(`${task.id} exited with code ${result.exitCode}`)
        })
        interruptions.add(failure)
        void failure.catch(() => undefined)
        return
      }

      const result = await raceWithInterruptions(child, interruptions)
      if (cancelled)
        return
      if (result.exitCode !== 0)
        throw new Error(`${task.id} exited with code ${result.exitCode}`)
    }
  }

  async function prepare(beforeTask?: string): Promise<void> {
    for (const preparation of plan.preparations ?? []) {
      if (preparation.beforeTask !== beforeTask || prepared.has(preparation.project))
        continue
      await runCommands(preparation)
      if (cancelled)
        return
      prepared.add(preparation.project)
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
          throw new Error(`Dependency ${dependency.id} was not started`)
        if (dependency.condition === 'completed') {
          const result = await raceWithInterruptions(child, interruptions)
          if (cancelled)
            return { children, cancelled }
          if (result.exitCode !== 0)
            throw new Error(`${dependency.id} exited with code ${result.exitCode}`)
        }
        else {
          const dependencyTask = plan.tasks.find(item => item.id === dependency.id)
          if (!dependencyTask)
            throw new Error(`Dependency task ${dependency.id} is missing`)
          await waitReady(child, dependencyTask, interruptions)
          if (cancelled)
            return { children, cancelled }
        }
      }

      if (cancelled)
        break
      if (!task.continuous && task.artifacts?.clean)
        await cleanOutputDirectory(task.projectRoot, task.outputDir)

      await prepare(task.id)
      if (cancelled)
        return { children, cancelled }

      await runCommands(task)
      if (cancelled)
        return { children, cancelled }

      if (!task.continuous && task.artifacts) {
        const artifactPath = await materializeArtifact({
          sourceDir: task.outputDir,
          artifactsRoot: plan.artifactsRoot,
          product: task.product,
          environment: plan.envName,
          variant: task.variant,
          projectRoot: task.projectRoot,
          mode: task.artifacts.mode,
          format: task.artifacts.format,
          retention: plan.artifactRetention,
        })
        consola.success(`Artifact: ${artifactPath}`)
      }
    }

    if (cancelled)
      return { children, cancelled }
    const services = plan.tasks.filter(task => task.continuous).map(task => children.get(task.id)!)
    if (services.length) {
      await raceWithInterruptions(Promise.race(services.map(async (child) => {
        const result = await child
        if (stopping.size)
          return
        if (result.exitCode !== 0)
          throw new Error(`Service exited with code ${result.exitCode}`)
      })), interruptions)
    }
    return { children, cancelled }
  }
  catch (error) {
    if (error !== cancellationError)
      throw error
    return { children, cancelled }
  }
  finally {
    try {
      if (cancelled || plan.tasks.some(task => task.continuous)) {
        await stopChildren()
      }
      else {
        await Promise.allSettled([...children.values()])
      }
    }
    finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
    }
  }
}
