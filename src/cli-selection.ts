import type { Args } from './cli-args.js'
import type { SelectionScreen } from './cli-screen.js'
import type { ExecutionPlan, NormalizedProduct } from './types.js'
import process from 'node:process'
import { isCancel, multiselect, note, outro, select } from '@clack/prompts'
import { CLI_COMMANDS } from './cli-args.js'
import { createSelectionScreen, isInteractiveTerminal } from './cli-screen.js'
import { defaultEnvironmentForTarget, listMatrixEnvironments, loadMatrixConfig } from './config.js'
import { createExecutionPlan } from './plan.js'

const preferredTargets = ['dev', 'build', 'dist', 'preview', 'test']
const builtinCommands: readonly string[] = Object.values(CLI_COMMANDS)
type LoadedConfig = Awaited<ReturnType<typeof loadMatrixConfig>>

export interface Selection {
  product: string
  target: string
  variants: string[]
  env: string
  plan: ExecutionPlan
  declaredEnvKeys: string[]
}

function supportedVariants(product: NormalizedProduct, target: string): string[] {
  return Object.keys(product.variants).filter(name => product.variants[name]!.targets[target])
}

function targetOptions(product: NormalizedProduct, variants: string[]): Array<{ value: string, label: string, hint: string }> {
  const names = variants.length ? variants : Object.keys(product.variants)
  for (const name of names) {
    if (!product.variants[name])
      throw new Error(`Unknown variant for product ${product.key}: ${name}`)
  }
  const targets = [...new Set(names.flatMap(name => Object.keys(product.variants[name]!.targets)))]
  return targets.filter(target => !variants.length || names.every(name => product.variants[name]!.targets[target]))
    .sort((a, b) => (!preferredTargets.includes(a) ? 99 : preferredTargets.indexOf(a)) - (!preferredTargets.includes(b) ? 99 : preferredTargets.indexOf(b)) || a.localeCompare(b))
    .map((value) => {
      const supported = supportedVariants(product, value)
      return { value, label: value, hint: supported.length === Object.keys(product.variants).length ? 'all variants' : `only ${supported.join(', ')}` }
    })
}

function validateSelection(product: NormalizedProduct, target: string, variants: string[]): void {
  for (const name of variants.length ? variants : Object.keys(product.variants)) {
    if (!product.variants[name])
      throw new Error(`Unknown variant for product ${product.key}: ${name}`)
    if (!product.variants[name]!.targets[target]) {
      const supported = supportedVariants(product, target)
      throw new Error(`Target ${target} is not available for ${product.key}/${name
      }${supported.length ? `. Select supported variants explicitly: --variant ${supported.join(',')}` : `. Available targets: ${targetOptions(product, []).map(option => option.value).join(', ')}`}`)
    }
  }
}

function quote(value: string): string {
  return /^[\w:.,/-]+$/.test(value) ? value : `'${value.replace(/'/g, '\'\\\'\'')}'`
}

export function selectionCommand(selection: Selection, plan = false): string {
  const action = plan
    ? [CLI_COMMANDS.plan, selection.product, '-t', selection.target]
    : builtinCommands.includes(selection.target)
      ? ['-p', selection.product, '-t', selection.target]
      : [selection.target, selection.product]
  return ['matrix', ...action, ...(selection.variants.length ? ['-v', selection.variants.join(',')] : []), '-e', selection.env].map(quote).join(' ')
}

export function selectionSummary(selection: Selection): string {
  const requested = selection.plan.tasks.filter(task => task.product === selection.product && task.target === selection.target
    && (!selection.variants.length || selection.variants.includes(task.variant)))
  const dependencies = selection.plan.tasks.filter(task => !requested.includes(task))
  return [
    `${selection.product} · ${selection.target} · ${requested.map(task => task.variant).join(', ')} · ${selection.env}`,
    `Node mode: ${[...new Set(requested.map(task => task.env.NODE_ENV))].join(', ')}`,
    ...(selection.plan.preparations ?? []).map(step => `Prepare: ${step.project} before ${step.beforeTask}`),
    ...(dependencies.length ? [`Dependencies: ${dependencies.map(task => task.id).join(', ')}`] : []),
    ...selection.plan.tasks.flatMap(task => task.dependsOn.map(dependency => `${task.id} waits for ${dependency.id} (${dependency.condition})`)),
  ].join('\n')
}

/** Complete only missing selections; a fully specified command never opens prompts. */
export async function resolveSelection(args: Args): Promise<Selection | null> {
  const screen = createSelectionScreen()
  let selection: Selection | null = null
  try {
    selection = await completeSelection(args, screen)
    if (screen.signal.aborted)
      selection = null
  }
  catch (error) {
    if (!screen.signal.aborted)
      throw error
  }
  finally {
    screen.close()
  }
  if (!selection) {
    if (!screen.signal.aborted)
      process.exitCode = 130
    outro('Cancelled')
  }
  return selection
}

async function completeSelection(args: Args, screen: SelectionScreen): Promise<Selection | null> {
  const interactive = isInteractiveTerminal()
  let target = args.target ?? (args.command && args.command !== CLI_COMMANDS.plan ? args.command : undefined)
  let env = args.env ?? defaultEnvironmentForTarget(target ?? 'dev')
  let loaded: LoadedConfig = await loadMatrixConfig({ envName: env, signal: screen.signal })
  let productKey = args.product
  let prompted = false

  if (!productKey) {
    const keys = Object.keys(loaded.products)
    if (keys.length === 1) {
      productKey = keys[0]!
    }
    else {
      if (!keys.length)
        throw new Error('No products configured')
      if (!interactive)
        throw new Error(`Product is required in non-interactive mode. Try: matrix <target> <product>. Products: ${keys.join(', ')}`)
      screen.page()
      const selected = await select({ signal: screen.signal, message: 'Select product', options: keys.map(value => ({ value, label: loaded.products[value]!.name, hint: `${value} · ${Object.keys(loaded.products[value]!.variants).join(', ')}` })) })
      if (isCancel(selected))
        return null
      productKey = selected
      prompted = true
    }
  }
  if (!loaded.products[productKey])
    throw new Error(`Unknown product: ${productKey}`)
  let variants = [...args.variants]

  while (true) {
    let product = loaded.products[productKey]!
    if (!product)
      throw new Error(`Product ${productKey} is not available in environment ${env}`)
    if (!target) {
      const options = targetOptions(product, args.variants)
      if (!options.length)
        throw new Error(`No targets available for product ${productKey}`)
      if (options.length === 1) {
        target = options[0]!.value
      }
      else {
        if (!interactive)
          throw new Error(`Target is required in non-interactive mode. Try: matrix <target> ${productKey}. Targets: ${options.map(option => option.value).join(', ')}`)
        screen.page()
        const selected = await select<string>({ signal: screen.signal, message: 'Select action', options, initialValue: options[0]!.value })
        if (isCancel(selected))
          return null
        target = selected
        prompted = true
      }
      // A discovered single-variant action explicitly selects its advertised scope.
      const supported = supportedVariants(product, target)
      variants = args.variants.length ? [...args.variants] : supported.length === Object.keys(product.variants).length ? [] : supported
      env = args.env ?? defaultEnvironmentForTarget(target)
    }
    if (loaded.envName !== env)
      loaded = await loadMatrixConfig({ envName: env, signal: screen.signal })
    product = loaded.products[productKey]!
    if (!product)
      throw new Error(`Product ${productKey} is not available in environment ${env}`)
    validateSelection(product, target, variants)
    const plan = createExecutionPlan({ config: loaded.config, projects: loaded.projects, products: loaded.products, externalEnv: loaded.externalEnv, cwd: loaded.cwd, productNames: [productKey], target, envName: env, ...(variants.length ? { variantNames: variants } : {}) })
    const declaredEnvKeys = [...new Set([...loaded.dotenvKeys, ...Object.keys(loaded.config.env ?? {}), ...Object.keys(product.env ?? {})])]
    const selection: Selection = { product: productKey, target, variants, env, plan, declaredEnvKeys }
    if (!interactive || (!prompted && (args.command || args.target)))
      return selection

    screen.page()
    const applicable = supportedVariants(product, target)
    const scope = variants.length ? variants : Object.keys(product.variants)
    const next = await select({
      signal: screen.signal,
      message: `${product.name} · ${target}`,
      options: [
        { value: 'run', label: args.command === CLI_COMMANDS.plan ? 'Print plan' : 'Run' },
        { value: 'variants', label: `Variants: ${scope.join(', ')}`, disabled: applicable.length <= 1 },
        { value: 'env', label: `Environment: ${env}` },
        { value: 'details', label: 'Execution details' },
        { value: 'back', label: 'Back to actions' },
      ],
    })
    if (isCancel(next))
      return null
    if (next === 'run')
      return selection
    if (next === 'back') {
      target = undefined
      variants = [...args.variants]
      env = args.env ?? defaultEnvironmentForTarget('dev')
      if (loaded.envName !== env)
        loaded = await loadMatrixConfig({ envName: env, signal: screen.signal })
    }
    else if (next === 'variants') {
      screen.page()
      const selected = await multiselect({ signal: screen.signal, message: 'Select variants (at least one)', required: true, initialValues: variants.length ? variants : applicable, options: applicable.map(value => ({ value, label: product.variants[value]!.name ?? value })) })
      if (isCancel(selected))
        return null
      variants = selected
    }
    else if (next === 'details') {
      screen.page()
      note(`${selectionSummary(selection)}\n\n${selectionCommand(selection, args.command === CLI_COMMANDS.plan)}`, 'Execution details')
      const selected = await select({ signal: screen.signal, message: 'Execution details', options: [{ value: 'back', label: 'Back to configuration' }] })
      if (isCancel(selected))
        return null
    }
    else {
      const environments = await listMatrixEnvironments({ productName: productKey, envName: env, signal: screen.signal })
      screen.page()
      const selected = await select({ signal: screen.signal, message: 'Select environment', initialValue: env, options: [...new Set([...environments, env])].map(value => ({ value, label: value })) })
      if (isCancel(selected))
        return null
      env = selected
    }
  }
}
