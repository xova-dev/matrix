#!/usr/bin/env node
import type { Args } from './cli-args.js'
import process from 'node:process'
import { isCancel, multiselect, outro, select } from '@clack/prompts'
import consola from 'consola'
import { CLI_HELP, parseArgs, validateCliArgs } from './cli-args.js'
import { defaultEnvironmentForTarget, listMatrixEnvironments, loadMatrixConfig } from './config.js'
import { MATRIX_DEFAULTS } from './defaults.js'
import { runExecutionPlan } from './exec.js'
import { createExecutionPlan, validateExecutionGraph } from './plan.js'

const sensitiveEnvKey = /token|secret|password|passwd|authorization|cookie|api[_-]?key|private[_-]?key/i

function redactPlan(plan: Awaited<ReturnType<typeof createExecutionPlan>>, visibleEnvKeys: Set<string>): Awaited<ReturnType<typeof createExecutionPlan>> {
  return {
    ...plan,
    tasks: plan.tasks.map(task => ({
      ...task,
      env: Object.fromEntries(Object.entries(task.env)
        .filter(([key]) => visibleEnvKeys.has(key) || key.startsWith('MATRIX_'))
        .map(([key, value]) => [key, sensitiveEnvKey.test(key) ? '***' : value])),
    })),
  }
}

type Products = Awaited<ReturnType<typeof loadMatrixConfig>>['products']
type Product = Products[string]

function availableTargets(product: Product, variantNames: string[] = []): string[] {
  const variants = variantNames.length
    ? variantNames.map(name => product.variants[name]).filter((variant): variant is Product['variants'][string] => variant !== undefined)
    : Object.values(product.variants)
  const targetSets = variants.map(variant => new Set(Object.keys(variant.targets)))
  return [...(targetSets[0] ?? new Set<string>())].filter(target => targetSets.every(targetSet => targetSet.has(target))).sort()
}

function validateVariants(product: Product, variantNames: string[]): void {
  for (const variantName of variantNames) {
    if (!product.variants[variantName])
      throw new Error(`Unknown variant for product ${product.key}: ${variantName}`)
  }
}

function validateTarget(target: string, product: Product, variantNames: string[] = []): void {
  const targets = availableTargets(product, variantNames)
  const available = targets.length ? targets.join(', ') : 'none'
  if (!targets.includes(target))
    throw new Error(`Unknown command or target for product ${product.key}: ${target}. Available targets: ${available}`)
}

async function chooseProduct(args: Args, products: Products): Promise<Args | null> {
  if (!args.product) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error('Product is required in non-interactive mode. Try: matrix <target> <product> or matrix --product <product>')
    const selected = await select({ message: 'Select product', options: Object.keys(products).map(value => ({ value, label: value })) })
    if (isCancel(selected))
      return null
    args.product = selected as string
  }
  if (args.product.includes(','))
    throw new Error('Only one product can be selected per run')
  if (!products[args.product])
    throw new Error(`Unknown product: ${args.product}`)
  return args
}

async function chooseTarget(args: Args, product: Product): Promise<Args | null> {
  const target = args.target ?? (args.command && args.command !== 'plan' ? args.command : undefined)
  if (target) {
    args.target = target
    return args
  }
  const targets = availableTargets(product, args.variants)
  if (!targets.length)
    throw new Error(`Product ${product.key} has no common targets`)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    args.target = targets.includes(MATRIX_DEFAULTS.target) ? MATRIX_DEFAULTS.target : targets[0]!
    return args
  }
  const selected = await select({
    message: 'Select target',
    initialValue: targets.includes(MATRIX_DEFAULTS.target) ? MATRIX_DEFAULTS.target : targets[0],
    options: targets.map(value => ({ value, label: value, ...(value === MATRIX_DEFAULTS.target ? { hint: 'default' } : {}) })),
  })
  if (isCancel(selected))
    return null
  args.target = selected as string
  return args
}

async function chooseVariants(args: Args, product: Product): Promise<Args | null> {
  const isInteractiveSelection = !args.command && process.stdin.isTTY && process.stdout.isTTY
  if (!args.variants.length && isInteractiveSelection && Object.keys(product.variants).length > 1) {
    const variants = Object.entries(product.variants)
    const selected = await multiselect({ message: 'Select variants (leave empty to select all)', options: variants.map(([value]) => ({ value, label: value })) })
    if (isCancel(selected))
      return null
    args.variants = selected as string[]
  }
  return args
}

async function chooseEnvironment(args: Args, target: string, environments: string[]): Promise<(Args & { env: string }) | null> {
  if (args.env)
    return args as Args & { env: string }
  const defaultEnvironment = defaultEnvironmentForTarget(target)
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const selected = await select({
      message: 'Select environment',
      initialValue: defaultEnvironment,
      options: environments.map(value => ({ value, label: value, ...(value === defaultEnvironment ? { hint: 'default' } : {}) })),
    })
    if (isCancel(selected))
      return null
    args.env = selected as string
  }
  else {
    args.env = defaultEnvironment
  }
  return args as Args & { env: string }
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  validateCliArgs(args)
  if (args.command === 'help' || args.help) {
    console.log(CLI_HELP)
    return
  }
  if (args.command === 'doctor') {
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
  const initialTarget = args.target ?? (args.command && args.command !== 'plan' ? args.command : MATRIX_DEFAULTS.target)
  const initialEnvironment = args.env ?? defaultEnvironmentForTarget(initialTarget)
  const initialLoaded = await loadMatrixConfig({ envName: initialEnvironment })
  const selectedProduct = await chooseProduct(args, initialLoaded.products)
  if (!selectedProduct)
    return outro('Cancelled')
  const product = initialLoaded.products[selectedProduct.product!]
  if (!product)
    throw new Error(`Unknown product: ${selectedProduct.product}`)
  validateVariants(product, selectedProduct.variants)
  const selected = await chooseVariants(selectedProduct, product)
  if (!selected)
    return outro('Cancelled')
  validateVariants(product, selected.variants)
  const selectedTarget = await chooseTarget(selected, product)
  if (!selectedTarget)
    return outro('Cancelled')
  const target = selectedTarget.target!
  if (selectedTarget.archive !== undefined && target !== 'build')
    throw new Error(`Archive options are only valid for the build target: ${target}`)
  validateTarget(target, product, selectedTarget.variants)
  const availableEnvironments = !selectedTarget.env && process.stdin.isTTY && process.stdout.isTTY
    ? await listMatrixEnvironments({ productName: selectedTarget.product! })
    : []
  const selectedEnvironment = await chooseEnvironment(selectedTarget, target, availableEnvironments)
  if (!selectedEnvironment)
    return outro('Cancelled')
  const loaded = selectedEnvironment.env === initialEnvironment
    ? initialLoaded
    : await loadMatrixConfig({ envName: selectedEnvironment.env })
  const selectedFinalProduct = loaded.products[selectedEnvironment.product!]
  if (!selectedFinalProduct)
    throw new Error(`Unknown product: ${selectedEnvironment.product}`)
  validateVariants(selectedFinalProduct, selectedEnvironment.variants)
  validateTarget(target, selectedFinalProduct, selectedEnvironment.variants)
  const command = selectedEnvironment.command ?? target
  const products = [selectedEnvironment.product!]
  const planInput = { config: loaded.config, projects: loaded.projects, products: loaded.products, externalEnv: loaded.externalEnv, cwd: loaded.cwd, productNames: products, target, envName: loaded.envName }
  const plan = selectedEnvironment.variants.length ? createExecutionPlan({ ...planInput, variantNames: selectedEnvironment.variants }) : createExecutionPlan(planInput)
  if (selectedEnvironment.archive !== undefined) {
    for (const task of plan.tasks) {
      if (task.target === 'build')
        task.archive.enabled = selectedEnvironment.archive
    }
  }
  if (command === 'plan') {
    const visibleEnvKeys = new Set(Object.keys(loaded.config.env ?? {}))
    for (const productName of products) {
      for (const key of Object.keys(loaded.config.products[productName]?.env ?? {}))
        visibleEnvKeys.add(key)
    }
    console.log(JSON.stringify(redactPlan(plan, visibleEnvKeys), null, 2))
    return
  }
  consola.info(`Plan: ${products[0]} / ${selectedEnvironment.variants.length ? selectedEnvironment.variants.join(', ') : 'all variants'} / ${target} / ${loaded.envName}`)
  const requestedVariants = selectedEnvironment.variants.length ? selectedEnvironment.variants : Object.keys(selectedFinalProduct.variants)
  const requestedTaskIds = new Set(requestedVariants.map(variant => `${products[0]}:${variant}:${target}`))
  const dependencies = plan.tasks.filter(task => !requestedTaskIds.has(task.id))
  if (dependencies.length)
    consola.info(`Including dependencies: ${dependencies.map(task => task.id).join(', ')}`)
  await runExecutionPlan(plan)
}
