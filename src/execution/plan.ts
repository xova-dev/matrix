import type { CreateExecutionPlanInput, ExecutionPlan, ExecutionTask, ProjectPreparation, TargetDependency } from '../types.js'
import path from 'pathe'
import { MATRIX_DEFAULTS } from '../config/defaults.js'
import { resolveSchemaEnv } from '../config/env-schema.js'
import { resolveExecutionContext } from '../product/context.js'
import { currentProcessEnv, mergeEnv } from '../utils/env.js'
import { resolveFilesystemPath } from '../utils/path.js'

export function dependencyCondition(dependency: TargetDependency, target: { continuous: boolean }): 'completed' | 'ready' {
  return dependency.condition ?? (target.continuous ? 'ready' : 'completed')
}

type PreparationPlanInput = Omit<CreateExecutionPlanInput, 'target' | 'variantNames'>

interface PlanErrorContext {
  product: string
  variant: string
  target: string
  kind: 'dependency' | 'environment' | 'version'
  dependencyIndex?: number
  path?: string
  cycle?: string[]
}

/** Preserve the failing task through recursive dependency planning without exposing values. */
export class ExecutionPlanError extends Error {
  constructor(error: unknown, readonly context: PlanErrorContext) {
    super(error instanceof Error ? error.message : 'Unable to create execution plan.', { cause: error })
  }
}

export function projectPreparation(input: PreparationPlanInput, projectName: string, context: { id: string, env: ProjectPreparation['env'] }): ProjectPreparation | undefined {
  const project = input.projects[projectName]
  if (!project)
    throw new Error(`Unknown project: ${projectName}`)
  if (project.prepare === undefined)
    return undefined
  return {
    id: `prepare:${context.id}`,
    project: projectName,
    command: project.prepare,
    cwd: resolveFilesystemPath(input.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot),
    env: { ...context.env },
  }
}

function executionPlan(input: PreparationPlanInput, tasks: ExecutionTask[], preparations: ProjectPreparation[]): ExecutionPlan {
  const contexts: Record<string, NonNullable<ExecutionPlan['contexts']>[string]> = {}
  for (const task of tasks)
    contexts[task.id] = Object.freeze({ env: Object.freeze({ ...task.env }) })
  // Host collection can visit products that were not selected as tasks. Capture
  // their inputs now too, without discovering hosts or resolving physical roots.
  // Defer failures so an unused project cannot prevent a native target running.
  for (const product of Object.values(input.products)) {
    for (const variant of Object.values(product.variants)) {
      for (const targetName of ['dev', 'build'] as const) {
        const id = `${product.key}:${variant.id}:${targetName}`
        if (contexts[id])
          continue
        try {
          const context = resolveExecutionContext({
            config: input.config,
            product,
            variant,
            envName: input.envName,
            projectRoot: resolveFilesystemPath(input.cwd, input.projects[variant.project]!.root ?? MATRIX_DEFAULTS.projectRoot),
            externalEnv: input.externalEnv ?? currentProcessEnv(),
            targetName,
            nodeEnv: variant.targets[targetName]?.nodeEnv ?? (targetName === 'dev' ? 'development' : 'production'),
          })
          contexts[id] = Object.freeze({ env: Object.freeze({ ...context.env }) })
        }
        catch (error) {
          contexts[id] = Object.freeze({ error })
        }
      }
    }
  }
  return {
    contexts: Object.freeze(contexts),
    ...(input.config.envSchema ? { envSchema: input.config.envSchema } : {}),
    envName: input.envName,
    tasks,
    ...(preparations.length ? { preparations } : {}),
    artifactsRoot: resolveFilesystemPath(input.cwd, input.config.artifacts?.root ?? MATRIX_DEFAULTS.artifactsRoot),
    artifactRetention: input.config.artifacts?.retention?.keep ?? MATRIX_DEFAULTS.artifacts.retention,
  }
}

/** Plans explicit project preparation without selecting or running a target. */
export function createPreparationPlan(input: PreparationPlanInput): ExecutionPlan {
  const plan = executionPlan(input, [], [])
  const preparations = new Map<string, ProjectPreparation>()
  for (const productName of input.productNames) {
    const product = input.products[productName]
    if (!product)
      throw new Error(`Unknown product: ${productName}`)
    for (const variant of Object.values(product.variants)) {
      for (const targetName of ['dev', 'build'] as const) {
        const id = `${product.key}:${variant.id}:${targetName}`
        const context = plan.contexts![id]!
        if ('error' in context)
          throw context.error
        const preparation = projectPreparation(input, variant.project, { id, env: context.env })
        if (preparation)
          preparations.set(preparation.id, preparation)
      }
    }
  }
  if (preparations.size)
    plan.preparations = [...preparations.values()]
  return plan
}

/**
 * Creates an ordered execution plan for one target across selected products or variants.
 *
 * Dependencies are expanded recursively and cycles are rejected. Environment values are
 * merged into each task before the plan is returned.
 */
export function createExecutionPlan(input: CreateExecutionPlanInput): ExecutionPlan {
  const tasks = new Map<string, ExecutionTask>()
  const preparations = new Map<string, ProjectPreparation>()
  const visiting = new Set<string>()
  const ordered: ExecutionTask[] = []

  const addTask = (productName: string, variantName: string, targetName: string): ExecutionTask => {
    const context: PlanErrorContext = { product: productName, variant: variantName, target: targetName, kind: 'dependency' }
    try {
      const id = `${productName}:${variantName}:${targetName}`
      const existing = tasks.get(id)
      if (existing)
        return existing
      if (visiting.has(id)) {
        const stack = [...visiting]
        const cycle = stack.slice(stack.indexOf(id))
        // Rotate, rather than sort, to preserve directed edges and distinguish overlapping cycles.
        const first = cycle.indexOf([...cycle].sort()[0]!)
        context.cycle = [...cycle.slice(first), ...cycle.slice(0, first)]
        throw new Error(`Dependency cycle detected at ${id}`)
      }

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
      const dependencyTasks = target.dependsOn.map((dependency, index) => {
        context.dependencyIndex = index
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
      delete context.dependencyIndex
      context.kind = 'environment'
      context.path = 'envSchema'
      const effectiveEnv = resolveSchemaEnv(mergeEnv(input.config.env, product.env, input.externalEnv ?? currentProcessEnv()), input.config.envSchema)
      const projectRoot = resolveFilesystemPath(input.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot)
      context.kind = 'version'
      context.path = effectiveEnv.MATRIX_PRODUCT_VERSION !== undefined
        ? 'MATRIX_PRODUCT_VERSION'
        : variant.version !== undefined
          ? `products.${productName}.variants.${variantName}.version`
          : product.version !== undefined
            ? `products.${productName}.version`
            : `${path.join(projectRoot, 'package.json')}#version`
      const identity = resolveExecutionContext({
        config: input.config,
        product,
        variant,
        envName: input.envName,
        externalEnv: input.externalEnv ?? currentProcessEnv(),
        nodeEnv: target.nodeEnv,
        projectRoot,
        requiredVersion: !target.continuous && !!target.artifacts,
        targetName,
      })
      const { version } = identity
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
        ...(version === undefined ? {} : { version }),
        command: target.command,
        cwd: projectRoot,
        env: identity.env,
        continuous: target.continuous,
        ...(target.artifacts ? { artifacts: target.artifacts } : {}),
        ...(target.readyWhen ? { readyWhen: target.readyWhen } : {}),
        outputDir: resolveFilesystemPath(projectRoot, target.outputDir),
        dependsOn: dependencyTasks,
      }
      if (target.prepare !== false) {
        const preparation = projectPreparation(input, variant.project, task)
        if (preparation)
          preparations.set(id, { ...preparation, beforeTask: id })
      }
      tasks.set(id, task)
      ordered.push(task)
      return task
    }
    catch (error) {
      if (error instanceof ExecutionPlanError)
        throw error
      throw new ExecutionPlanError(error, context)
    }
  }

  for (const productName of input.productNames) {
    const product = input.products[productName]
    if (!product)
      throw new Error(`Unknown product: ${productName}`)
    const selected = input.variantNames?.length ? input.variantNames : Object.keys(product.variants)
    for (const variantName of selected) addTask(productName, variantName, input.target)
  }

  return executionPlan(input, ordered, [...preparations.values()])
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
