#!/usr/bin/env node
import type { EnvMap } from './types.js'
import path from 'node:path'
import process from 'node:process'
import consola from 'consola'
import { CLI_COMMANDS, cliHelp, parseArgs, validateCliArgs } from './cli-args.js'
import { resolveSelection, selectionCommand, selectionSummary } from './cli-selection.js'
import { loadMatrixConfig } from './config.js'
import { MATRIX_DEFAULTS } from './defaults.js'
import { runExecutionPlan } from './exec.js'
import { validateExecutionGraph } from './plan.js'
import { generateMatrixTypes, matrixTypeEnvKeys } from './typegen.js'

type Products = Awaited<ReturnType<typeof loadMatrixConfig>>['products']
type Product = Products[string]
type LoadedConfig = Awaited<ReturnType<typeof loadMatrixConfig>>

async function generateProjectTypes(loaded: LoadedConfig, products: Product[]): Promise<string[]> {
  const projectProducts = new Map<string, Product[]>()
  for (const product of products) {
    for (const variant of Object.values(product.variants)) {
      if (!loaded.projects[variant.project])
        throw new Error(`Variant ${product.key}/${variant.id} references unknown project ${variant.project}`)
      const linkedProducts = projectProducts.get(variant.project) ?? []
      if (!linkedProducts.includes(product))
        linkedProducts.push(product)
      projectProducts.set(variant.project, linkedProducts)
    }
  }

  const outputs: string[] = []
  for (const [projectName, linkedProducts] of projectProducts) {
    const project = loaded.projects[projectName]!
    const envs: Array<EnvMap | undefined> = [loaded.config.env, loaded.externalEnv, ...linkedProducts.map(product => product.env)]
    outputs.push(await generateMatrixTypes({
      cwd: path.resolve(loaded.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot),
      env: matrixTypeEnvKeys(...envs),
    }))
  }
  return outputs
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  validateCliArgs(args)
  if (args.command === CLI_COMMANDS.help || args.help) {
    console.log(await cliHelp())
    return
  }
  if (args.command === CLI_COMMANDS.doctor) {
    const loaded = await loadMatrixConfig({ ...(args.env ? { envName: args.env } : {}) })
    validateExecutionGraph({
      config: loaded.config,
      projects: loaded.projects,
      products: loaded.products,
      externalEnv: loaded.externalEnv,
      cwd: loaded.cwd,
      envName: loaded.envName,
    })
    consola.success(`Configuration is valid: ${loaded.configFile ?? 'matrix.config.ts'}`)
    return
  }
  if (args.command === CLI_COMMANDS.prepare) {
    const loaded = await loadMatrixConfig({ ...(args.env ? { envName: args.env } : {}) })
    const selectedProduct = args.product ? loaded.products[args.product] : undefined
    if (args.product && !selectedProduct)
      throw new Error(`Unknown product: ${args.product}`)
    const products = selectedProduct ? [selectedProduct] : Object.values(loaded.products)
    const outputs = await generateProjectTypes(loaded, products)
    for (const output of outputs)
      consola.success(`Types generated: ${output}`)
    return
  }
  const selection = await resolveSelection(args)
  if (!selection)
    return
  if (args.command === CLI_COMMANDS.plan) {
    const { plan } = selection
    const declaredEnvKeys = new Set(selection.declaredEnvKeys)
    console.log(JSON.stringify({
      ...plan,
      tasks: plan.tasks.map(({ env, ...task }) => ({
        ...task,
        env: Object.fromEntries(Object.entries(env).filter(([key]) => declaredEnvKeys.has(key) || key.startsWith('MATRIX_') || key === 'NODE_ENV')),
      })),
    }, null, 2))
    return
  }
  consola.info(`${selectionSummary(selection)}\n${selectionCommand(selection)}`)
  await runExecutionPlan(selection.plan)
}
