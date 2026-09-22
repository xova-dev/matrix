import type { CreateExecutionPlanInput, EnvMap, ExecutionPlan, ExecutionTask, NormalizedProduct, NormalizedVariant, TargetDependency } from './types.js'
import path from 'node:path'
import process from 'node:process'
import { MATRIX_DEFAULTS } from './defaults.js'

function mergeEnv(...maps: Array<EnvMap | undefined>): EnvMap {
  return Object.assign({}, ...maps.filter(Boolean))
}

function currentProcessEnv(): EnvMap {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function applySuffix(value: string | undefined, suffix: string | undefined): string | undefined {
  return value === undefined || suffix === undefined ? value : `${value}${suffix}`
}

function envString(env: EnvMap, key: string): string | undefined {
  const value = env[key]
  return value === undefined ? undefined : String(value)
}

function mergeSuffixes(...sources: Array<Record<string, { name?: string, slug?: string, appId?: string }> | undefined>): Record<string, { name?: string, slug?: string, appId?: string }> {
  const result: Record<string, { name?: string, slug?: string, appId?: string }> = {}
  for (const source of sources) {
    for (const [env, value] of Object.entries(source ?? {})) result[env] = { ...result[env], ...value }
  }
  return result
}

function resolvedVariant(product: NormalizedProduct, variant: NormalizedVariant, envName: string, env: EnvMap): { id: string, name: string, slug: string, appId: string | undefined } {
  const suffix = { ...(product.suffixes?.[envName] ?? {}), ...(variant.suffixes?.[envName] ?? {}) }
  const name = envString(env, 'MATRIX_PRODUCT_NAME') ?? variant.name ?? product.name
  const slug = envString(env, 'MATRIX_PRODUCT_SLUG') ?? variant.slug ?? product.slug
  const appId = envString(env, 'MATRIX_PRODUCT_APP_ID') ?? variant.appId ?? product.appId
  return {
    id: product.id,
    name: applySuffix(name, suffix.name)!,
    slug: applySuffix(slug, suffix.slug)!,
    appId: applySuffix(appId, suffix.appId),
  }
}

function dependencyCondition(dependency: TargetDependency, target: { continuous: boolean }): 'completed' | 'ready' {
  return dependency.condition ?? (target.continuous ? 'ready' : 'completed')
}

/**
 * Creates an ordered execution plan for one target across selected products or variants.
 *
 * Dependencies are expanded recursively and cycles are rejected. Environment values are
 * merged into each task before the plan is returned.
 */
export function createExecutionPlan(input: CreateExecutionPlanInput): ExecutionPlan {
  const tasks = new Map<string, ExecutionTask>()
  const visiting = new Set<string>()
  const ordered: ExecutionTask[] = []

  const addTask = (productName: string, variantName: string, targetName: string): ExecutionTask => {
    const id = `${productName}:${variantName}:${targetName}`
    const existing = tasks.get(id)
    if (existing)
      return existing
    if (visiting.has(id))
      throw new Error(`Dependency cycle detected at ${id}`)

    const product = input.products[productName]
    if (!product)
      throw new Error(`Unknown product: ${productName}`)
    const variant = product.variants[variantName]
    if (!variant)
      throw new Error(`Unknown variant ${variantName} for product ${productName}`)
    const project = input.projects[variant.project]
    if (!project)
      throw new Error(`Variant ${productName}/${variantName} references unknown project ${variant.project}`)
    const target = variant.targets[targetName]
    if (!target)
      throw new Error(`Variant ${productName}/${variantName} has no target ${targetName}`)

    visiting.add(id)
    const dependencyTasks = target.dependsOn.map((dependency) => {
      const dependencyTargetName = dependency.target ?? targetName
      const dependencyVariant = product.variants[dependency.variant]
      if (!dependencyVariant)
        throw new Error(`Unknown dependency variant ${productName}/${dependency.variant}`)
      const dependencyTarget = dependencyVariant.targets[dependencyTargetName]
      if (!dependencyTarget)
        throw new Error(`Variant ${productName}/${dependency.variant} has no target ${dependencyTargetName}`)
      const dependencyTask = addTask(productName, dependency.variant, dependencyTargetName)
      return { id: dependencyTask.id, condition: dependencyCondition(dependency, dependencyTarget) }
    })
    visiting.delete(id)

    const effectiveEnv = mergeEnv(input.config.env, product.env, input.externalEnv ?? currentProcessEnv())
    const identity = resolvedVariant({ ...product, suffixes: mergeSuffixes(input.config.suffixes, product.suffixes) }, variant, input.envName, effectiveEnv)
    const projectRoot = path.resolve(input.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot)
    const task: ExecutionTask = {
      id,
      product: productName,
      variant: variantName,
      project: variant.project,
      projectRoot,
      target: targetName,
      name: identity.name,
      slug: identity.slug,
      ...(identity.appId ? { appId: identity.appId } : {}),
      command: target.command,
      cwd: projectRoot,
      env: mergeEnv(effectiveEnv, {
        MATRIX_ENV_NAME: input.envName,
        MATRIX_TARGET: targetName,
        MATRIX_PRODUCT_KEY: productName,
        MATRIX_PRODUCT_ID: identity.id,
        MATRIX_PRODUCT_NAME: identity.name,
        MATRIX_PRODUCT_SLUG: identity.slug,
        MATRIX_VARIANT: variantName,
        MATRIX_PROJECT: variant.project,
        MATRIX_NODE_ENV: target.nodeEnv,
        NODE_ENV: target.nodeEnv,
        ...(identity.appId
          ? { MATRIX_PRODUCT_APP_ID: identity.appId }
          : {}),
      }),
      continuous: target.continuous,
      ...(target.artifacts ? { artifacts: target.artifacts } : {}),
      ...(target.readyWhen ? { readyWhen: target.readyWhen } : {}),
      outputDir: path.resolve(projectRoot, target.outputDir),
      dependsOn: dependencyTasks,
    }
    tasks.set(id, task)
    ordered.push(task)
    return task
  }

  for (const productName of input.productNames) {
    const product = input.products[productName]
    if (!product)
      throw new Error(`Unknown product: ${productName}`)
    const selected = input.variantNames?.length ? input.variantNames : Object.keys(product.variants)
    for (const variantName of selected) addTask(productName, variantName, input.target)
  }

  return {
    envName: input.envName,
    tasks: ordered,
    artifactsRoot: path.resolve(input.cwd, input.config.artifacts?.root ?? MATRIX_DEFAULTS.artifactsRoot),
    artifactRetention: input.config.artifacts?.retention?.keep ?? MATRIX_DEFAULTS.artifacts.retention,
  }
}

/** Validates every configured product, variant, and target without starting any process. */
export function validateExecutionGraph(input: Omit<CreateExecutionPlanInput, 'productNames' | 'variantNames' | 'target'>): void {
  for (const [productName, product] of Object.entries(input.products)) {
    for (const [variantName, variant] of Object.entries(product.variants)) {
      for (const targetName of Object.keys(variant.targets)) {
        createExecutionPlan({
          ...input,
          productNames: [productName],
          variantNames: [variantName],
          target: targetName,
        })
      }
    }
  }
}
