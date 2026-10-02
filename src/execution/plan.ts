import type { CreateExecutionPlanInput, ExecutionPlan, ExecutionTask, ProjectPreparation, TargetDependency } from '../types.js'
import path from 'pathe'
import { MATRIX_DEFAULTS } from '../config/defaults.js'
import { resolveSchemaEnv } from '../config/env-schema.js'
import { resolveProductContext } from '../product/context.js'
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

function projectPreparation(input: PreparationPlanInput, projectName: string): ProjectPreparation | undefined {
  const project = input.projects[projectName]
  if (!project)
    throw new Error(`Unknown project: ${projectName}`)
  if (project.prepare === undefined)
    return undefined
  return {
    id: `prepare:${projectName}`,
    project: projectName,
    command: project.prepare,
    cwd: resolveFilesystemPath(input.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot),
    env: resolveSchemaEnv(mergeEnv(input.config.env, input.externalEnv ?? currentProcessEnv(), {
      MATRIX_ENV_NAME: input.envName,
      MATRIX_PROJECT: projectName,
      MATRIX_TARGET: 'prepare',
    }), input.config.envSchema),
  }
}

function executionPlan(input: PreparationPlanInput, tasks: ExecutionTask[], preparations: ProjectPreparation[]): ExecutionPlan {
  return {
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
  const preparations = new Map<string, ProjectPreparation>()
  for (const productName of input.productNames) {
    const product = input.products[productName]
    if (!product)
      throw new Error(`Unknown product: ${productName}`)
    for (const variant of Object.values(product.variants)) {
      if (preparations.has(variant.project))
        continue
      const preparation = projectPreparation(input, variant.project)
      if (preparation)
        preparations.set(variant.project, preparation)
    }
  }
  return executionPlan(input, [], [...preparations.values()])
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
      if (target.prepare !== false && !preparations.has(variant.project)) {
        const preparation = projectPreparation(input, variant.project)
        if (preparation)
          preparations.set(variant.project, { ...preparation, beforeTask: id })
      }

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
      const identity = resolveProductContext({
        config: input.config,
        product,
        variant,
        envName: input.envName,
        env: effectiveEnv,
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
        env: mergeEnv(effectiveEnv, {
          MATRIX_ENV_NAME: input.envName,
          MATRIX_TARGET: targetName,
          ...identity.env,
          MATRIX_VARIANT: variantName,
          MATRIX_PROJECT: variant.project,
          MATRIX_NODE_ENV: target.nodeEnv,
          NODE_ENV: target.nodeEnv,
        }),
        continuous: target.continuous,
        ...(target.artifacts ? { artifacts: target.artifacts } : {}),
        ...(target.readyWhen ? { readyWhen: target.readyWhen } : {}),
        outputDir: resolveFilesystemPath(projectRoot, target.outputDir),
        dependsOn: dependencyTasks,
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
