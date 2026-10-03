#!/usr/bin/env node
import type { EnvMap } from '../types.js'
import process from 'node:process'
import consola from 'consola'
import { loadMatrixConfig } from '../config/index.js'
import { diagnoseWorkspace } from '../execution/doctor.js'
import { runExecutionPlan } from '../execution/exec.js'
import { createPreparationPlan } from '../execution/plan.js'
import { ExecutionReport } from '../execution/report.js'
import { TypePreparationCancelled } from '../typegen/prepare.js'
import { generateProjectTypes, ProjectTypePreparationError } from '../typegen/project.js'
import { CLI_COMMANDS, cliHelp, parseArgs, validateCliArgs } from './args.js'
import { resolveSelection, selectionCommand, selectionSummary } from './selection.js'

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  validateCliArgs(args)
  if (args.command === CLI_COMMANDS.help || args.help) {
    console.log(await cliHelp())
    return
  }
  if (args.command === CLI_COMMANDS.doctor) {
    const loaded = await loadMatrixConfig({ ...(args.env ? { envName: args.env } : {}) })
    const diagnostics = await diagnoseWorkspace({
      config: loaded.config,
      projects: loaded.projects,
      products: loaded.products,
      externalEnv: loaded.externalEnv,
      cwd: loaded.cwd,
      envName: loaded.envName,
    })
    for (const diagnostic of diagnostics) {
      const message = [diagnostic.subject, `(${diagnostic.path}):`, diagnostic.message, 'Fix:', diagnostic.suggestion, ...(diagnostic.blockedTasks?.length ? [`Blocked: ${diagnostic.blockedTasks.join(', ')}`] : [])].join(' ')
      if (diagnostic.severity === 'error')
        consola.error(message)
      else
        consola.warn(message)
    }
    const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error').length
    if (errors)
      throw new Error(`Doctor found ${errors} error(s).`)
    consola.success(`Configuration is valid: ${loaded.configFile ?? 'matrix.config.ts'}`)
    return
  }
  if (args.command === CLI_COMMANDS.prepare) {
    const loaded = await loadMatrixConfig({ ...(args.env ? { envName: args.env } : {}) })
    const selectedProduct = args.product ? loaded.products[args.product] : undefined
    if (args.product && !selectedProduct)
      throw new Error(`Unknown product: ${args.product}`)
    const products = selectedProduct ? [selectedProduct] : Object.values(loaded.products)
    const plan = createPreparationPlan({ ...loaded, productNames: products.map(product => product.key) })
    const report = new ExecutionReport(plan)
    const controller = new AbortController()
    const cancel = (signal: 'SIGINT' | 'SIGTERM'): void => {
      if (controller.signal.aborted)
        return
      process.exitCode = signal === 'SIGINT' ? 130 : 143
      report.cancel(signal)
      controller.abort(new TypePreparationCancelled(`Preparation cancelled (${signal})`))
    }
    const interrupt = (): void => cancel('SIGINT')
    const terminate = (): void => cancel('SIGTERM')
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    let generatingTypes = false
    try {
      const result = await runExecutionPlan(plan, { report })
      if (result.cancelled) {
        process.exitCode = result.cancelled === 'SIGINT' ? 130 : 143
        return
      }
      generatingTypes = true
      await generateProjectTypes(loaded, products, { signal: controller.signal, onOutput: output => report.artifact(output) })
    }
    catch (error) {
      if (!generatingTypes)
        throw error
      if (error instanceof TypePreparationCancelled) {
        report.cancel(process.exitCode === 143 ? 'SIGTERM' : 'SIGINT')
      }
      else {
        throw report.fail({
          id: 'prepare:types',
          phase: 'preparation',
          ...(error instanceof ProjectTypePreparationError ? { project: error.project, ...(error.task ? { affectedTask: error.task } : {}) } : {}),
        }, error)
      }
    }
    finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
      report.print()
    }
    return
  }
  const selection = await resolveSelection(args)
  if (!selection)
    return
  if (args.command === CLI_COMMANDS.plan) {
    const { plan } = selection
    const { envSchema: _envSchema, ...visiblePlan } = plan
    const declaredEnvKeys = new Set(selection.declaredEnvKeys)
    const visibleEnv = (env: EnvMap): EnvMap => Object.fromEntries(Object.entries(env).filter(([key]) => declaredEnvKeys.has(key) || key.startsWith('MATRIX_') || key === 'NODE_ENV'))
    console.log(JSON.stringify({
      ...visiblePlan,
      ...(plan.preparations ? { preparations: plan.preparations.map(step => ({ ...step, env: visibleEnv(step.env) })) } : {}),
      tasks: plan.tasks.map(({ env, ...task }) => ({
        ...task,
        env: visibleEnv(env),
      })),
    }, null, 2))
    return
  }
  consola.info(`${selectionSummary(selection)}\n${selectionCommand(selection)}`)
  const result = await runExecutionPlan(selection.plan)
  if (result.cancelled)
    process.exitCode = result.cancelled === 'SIGINT' ? 130 : 143
}
