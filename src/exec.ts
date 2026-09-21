import type { ExecutionPlan, ExecutionTask } from './types.js'
import { mkdir, rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import consola from 'consola'
import { execaCommand } from 'execa'
import { materializeArtifact } from './artifact.js'

type Child = ReturnType<typeof execaCommand>
const shutdownGracePeriod = 5_000
const neverSettles: Promise<never> = new Promise(() => undefined)

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function raceWithServiceFailures<T>(promise: Promise<T>, failures: Set<Promise<never>>): Promise<T> {
  return failures.size ? Promise.race([promise, ...failures]) : promise
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

async function waitReady(child: Child, task: ExecutionTask, serviceFailures: Set<Promise<never>>): Promise<void> {
  const readyWhen = task.readyWhen
  if (!readyWhen)
    return

  const timeout = readyWhen.timeout ?? 30_000
  const deadline = Date.now() + timeout
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0)
      break
    if (await raceWithServiceFailures(canConnect(readyWhen.host ?? '127.0.0.1', readyWhen.port, Math.min(1_000, remaining)), serviceFailures))
      return
    const result = await raceWithServiceFailures(Promise.race([
      child.then(value => value),
      new Promise<undefined>(resolve => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now())))),
    ]), serviceFailures)
    if (result !== undefined)
      throw new Error(`${task.id} exited before becoming ready`)
  }
  throw new Error(`Timed out waiting for ${task.id} on port ${readyWhen.port}`)
}

async function stopChildren(children: Map<string, Child>, stopping: Set<string>, settled: Set<string>): Promise<void> {
  for (const [id, child] of children) {
    if (!stopping.has(id)) {
      stopping.add(id)
      child.kill('SIGTERM')
    }
  }

  await Promise.race([Promise.allSettled([...children.values()]), wait(shutdownGracePeriod)])
  for (const [id, child] of children) {
    if (!settled.has(id)) {
      stopping.add(id)
      child.kill('SIGKILL')
    }
  }
  await Promise.allSettled([...children.values()])
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
export async function runExecutionPlan(plan: ExecutionPlan): Promise<{ children: Map<string, Child> }> {
  const children = new Map<string, Child>()
  const stopping = new Set<string>()
  const settled = new Set<string>()
  const serviceFailures = new Set<Promise<never>>()
  const stopAll = (): void => {
    for (const [id, child] of children) {
      if (!stopping.has(id)) {
        stopping.add(id)
        child.kill('SIGTERM')
      }
    }
  }

  process.on('SIGINT', stopAll)
  process.on('SIGTERM', stopAll)
  try {
    for (const task of plan.tasks) {
      for (const dependency of task.dependsOn) {
        const child = children.get(dependency.id)
        if (!child)
          throw new Error(`Dependency ${dependency.id} was not started`)
        if (dependency.condition === 'completed') {
          const result = await raceWithServiceFailures(child, serviceFailures)
          if (result.exitCode !== 0)
            throw new Error(`${dependency.id} exited with code ${result.exitCode}`)
        }
        else {
          const dependencyTask = plan.tasks.find(item => item.id === dependency.id)
          if (!dependencyTask)
            throw new Error(`Dependency task ${dependency.id} is missing`)
          await waitReady(child, dependencyTask, serviceFailures)
        }
      }

      if (!task.continuous && task.artifacts.clean)
        await cleanOutputDirectory(task.projectRoot, task.outputDir)

      const commands = Array.isArray(task.command) ? task.command : [task.command]
      for (const [index, command] of commands.entries()) {
        consola.info(`${task.id} [${index + 1}/${commands.length}] → ${command}`)
        const child = execaCommand(command, {
          cwd: task.cwd,
          env: Object.fromEntries(Object.entries(task.env).map(([key, value]) => [key, String(value)])),
          extendEnv: true,
          stdio: 'inherit',
          reject: false,
          killDescendants: true,
        }) as Child
        children.set(task.id, child)
        void child.then(() => settled.add(task.id), () => settled.add(task.id))

        if (task.continuous) {
          const failure = child.then((result) => {
            if (stopping.size || result.exitCode === 0)
              return neverSettles
            throw new Error(`${task.id} exited with code ${result.exitCode}`)
          })
          serviceFailures.add(failure)
          void failure.catch(() => undefined)
          break
        }

        const result = await raceWithServiceFailures(child, serviceFailures)
        if (result.exitCode !== 0)
          throw new Error(`${task.id} exited with code ${result.exitCode}`)
      }

      if (!task.continuous && task.artifacts.mode !== 'none') {
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

    const services = plan.tasks.filter(task => task.continuous).map(task => children.get(task.id)!)
    if (services.length) {
      await raceWithServiceFailures(Promise.race(services.map(async (child) => {
        const result = await child
        if (stopping.size)
          return
        if (result.exitCode !== 0)
          throw new Error(`Service exited with code ${result.exitCode}`)
      })), serviceFailures)
    }
    return { children }
  }
  finally {
    if (plan.tasks.some(task => task.continuous))
      await stopChildren(children, stopping, settled)
    else
      await Promise.allSettled([...children.values()])
    process.removeListener('SIGINT', stopAll)
    process.removeListener('SIGTERM', stopAll)
  }
}
