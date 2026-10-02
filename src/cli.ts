#!/usr/bin/env node
import type { GenerateMatrixTypesOptions } from './typegen.js'
import type { EnvMap } from './types.js'
import path from 'node:path'
import process from 'node:process'
import consola from 'consola'
import { CLI_COMMANDS, cliHelp, parseArgs, validateCliArgs } from './cli-args.js'
import { resolveSelection, selectionCommand, selectionSummary } from './cli-selection.js'
import { loadMatrixConfig } from './config.js'
import { MATRIX_DEFAULTS } from './defaults.js'
import { diagnoseWorkspace } from './doctor.js'
import { MATRIX_ENV_SCHEMA_KEY, resolveSchemaEnv, serializeEnvSchema } from './env-schema.js'
import { runExecutionPlan } from './exec.js'
import { createPreparationPlan } from './plan.js'
import { findTypeHost, mergePreparedTypes, resolveHostTypes, TypePreparationCancelled } from './prepare-types.js'
import { resolveProductContext } from './product-context.js'
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

  const batches: GenerateMatrixTypesOptions[][] = []
  for (const [projectName, linkedProducts] of projectProducts) {
    const project = loaded.projects[projectName]!
    const cwd = path.resolve(loaded.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot)
    const host = await findTypeHost(cwd, project.configFile)
    const envs: Array<EnvMap | undefined> = [loaded.config.env, loaded.externalEnv, ...linkedProducts.map(product => product.env)]
    const genericTypes: GenerateMatrixTypesOptions[] = [{
      cwd,
      env: matrixTypeEnvKeys(...envs),
      ...(loaded.config.envSchema ? { envSchema: loaded.config.envSchema } : {}),
    }]
    if (host) {
      let expectedScopes: string | undefined
      for (const product of linkedProducts) {
        for (const variant of Object.values(product.variants).filter(variant => variant.project === projectName)) {
          const effectiveEnv = resolveSchemaEnv({
            ...loaded.config.env,
            ...product.env,
            ...loaded.externalEnv,
          }, loaded.config.envSchema)
          const identity = resolveProductContext({ config: loaded.config, product, variant, envName: loaded.envName, env: effectiveEnv, projectRoot: cwd })
          const env = {
            ...effectiveEnv,
            ...identity.env,
            NODE_ENV: 'development',
            MATRIX_NODE_ENV: 'development',
            MATRIX_ENV_NAME: loaded.envName,
            MATRIX_PROJECT: projectName,
            MATRIX_VARIANT: variant.id,
            MATRIX_TARGET: 'prepare',
            [MATRIX_ENV_SCHEMA_KEY]: serializeEnvSchema(loaded.config.envSchema),
          }
          const preparedTypes = await resolveHostTypes(cwd, env, { host, mode: loaded.envName })
          const scopes = JSON.stringify(preparedTypes?.map(type => [type.cwd, type.scope ?? '']).sort() ?? null)
          if (expectedScopes !== undefined && scopes !== expectedScopes)
            throw new Error(`Matrix scopes change between products or variants in ${cwd}; keep the type contract stable.`)
          expectedScopes = scopes
          batches.push(preparedTypes ?? genericTypes)
        }
      }
      continue
    }
    batches.push(genericTypes)
  }
  const outputs: string[] = []
  for (const options of mergePreparedTypes(batches))
    outputs.push(await generateMatrixTypes(options))
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
    const result = await runExecutionPlan(createPreparationPlan({ ...loaded, productNames: products.map(product => product.key) }))
    if (result.cancelled) {
      process.exitCode = result.cancelled === 'SIGINT' ? 130 : 143
      return
    }
    try {
      const outputs = await generateProjectTypes(loaded, products)
      for (const output of outputs)
        consola.success(`Types generated: ${output}`)
    }
    catch (error) {
      if (!(error instanceof TypePreparationCancelled))
        throw error
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
