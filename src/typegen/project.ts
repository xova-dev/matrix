import type { loadMatrixConfig } from '../config/index.js'
import type { GenerateMatrixTypesOptions } from './generate.js'
import { MATRIX_DEFAULTS } from '../config/defaults.js'
import { MATRIX_ENV_SCHEMA_KEY, resolveSchemaEnv, serializeEnvSchema } from '../config/env-schema.js'
import { resolveProductContext } from '../product/context.js'
import { containsPath, resolveExistingPath, resolveFilesystemPath, resolveFuturePath } from '../utils/path.js'
import { generateMatrixTypes, matrixTypeEnvKeys, matrixTypeOutput } from './generate.js'
import { withTypePreparationLock } from './lock.js'
import { findTypeHost, mergePreparedTypes, resolveHostTypes, TypePreparationCancelled } from './prepare.js'

type Products = Awaited<ReturnType<typeof loadMatrixConfig>>['products']
type Product = Products[string]
type LoadedConfig = Awaited<ReturnType<typeof loadMatrixConfig>>

export class ProjectTypePreparationError extends Error {
  constructor(error: unknown, readonly project: string, readonly task?: string) {
    super(error instanceof Error ? error.message : 'Unable to generate project types', { cause: error })
  }
}

interface ProjectTypeOptions {
  automatic?: boolean
  onHost?: () => void
  onOutput?: (output: string) => void
  onDeclaration?: (declaration: GenerateMatrixTypesOptions) => void
  signal?: AbortSignal
  /** Execution tasks determine affected projects, including dependency projects. */
  projects?: string[]
}

export async function generateProjectTypes(loaded: LoadedConfig, products: Product[], options: ProjectTypeOptions = {}): Promise<string[]> {
  return withTypePreparationLock(loaded.cwd, () => collectProjectTypes(loaded, products, options), options.signal)
}

async function collectProjectTypes(loaded: LoadedConfig, products: Product[], options: ProjectTypeOptions): Promise<string[]> {
  const { onOutput, signal } = options
  const preparationError = (error: unknown, project: string, task?: string): Error => {
    if (error instanceof TypePreparationCancelled)
      return error
    if (signal?.aborted && (error === signal.reason || (error instanceof Error && error.name === 'AbortError')))
      return signal.reason instanceof TypePreparationCancelled ? signal.reason : new TypePreparationCancelled('Type preparation cancelled', { cause: error })
    return new ProjectTypePreparationError(error, project, task)
  }
  const checkCancellation = (): void => {
    if (signal?.aborted)
      throw preparationError(signal.reason, 'types')
  }
  checkCancellation()
  const affectedProjects = new Set(options.projects ?? products.flatMap(product => Object.values(product.variants).map(variant => variant.project)))
  // Automatic host discovery belongs to the selected task, not an overlapping neighbor.
  // Non-Vite adapters retain their own generation even when a nested project uses Vite.
  if (options.automatic) {
    for (const name of affectedProjects) {
      const project = loaded.projects[name]
      if (!project)
        throw new Error(`Unknown project ${name}`)
      if (!await findTypeHost(resolveFilesystemPath(loaded.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot), project.configFile, signal))
        affectedProjects.delete(name)
    }
    if (!affectedProjects.size)
      return []
  }
  // Overlapping physical roots can own the same output, including nested project aliases.
  const roots = new Map<string, string>()
  for (const [name, project] of Object.entries(loaded.projects))
    roots.set(name, await resolveFuturePath(resolveFilesystemPath(loaded.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot)))
  let expanded = true
  while (expanded) {
    expanded = false
    for (const [name, root] of roots) {
      if (affectedProjects.has(name))
        continue
      if ([...affectedProjects].some(selected => roots.has(selected) && (containsPath(roots.get(selected)!, root) || containsPath(root, roots.get(selected)!)))) {
        affectedProjects.add(name)
        expanded = true
      }
    }
  }
  const projectProducts = new Map<string, Product[]>()
  for (const projectName of affectedProjects) {
    if (!loaded.projects[projectName])
      throw new Error(`Unknown project ${projectName}`)
    projectProducts.set(projectName, Object.values(loaded.products).filter(product => Object.values(product.variants).some(variant => variant.project === projectName)))
  }

  const batches: GenerateMatrixTypesOptions[][] = []
  const outputSources = new Map<string, { projects: Set<string>, tasks: Set<string> }>()
  const addBatch = async (batch: GenerateMatrixTypesOptions[], project: string, tasks: string[]): Promise<void> => {
    for (const declaration of batch) {
      const output = await resolveFuturePath(matrixTypeOutput(declaration))
      const root = roots.get(project)!
      if (!containsPath(root, declaration.cwd) || !containsPath(root, output))
        throw new Error(`Cannot establish Matrix type output ownership for project ${project}: host root ${declaration.cwd} and output ${output} must stay within project.root ${root}. Set project.root to the actual shared host project directory; use project.configFile to reference a configuration stored elsewhere.`)
      declaration.typeProjectRoot = root
      declaration.output = output
      const source = outputSources.get(output) ?? { projects: new Set<string>(), tasks: new Set<string>() }
      source.projects.add(project)
      for (const task of tasks)
        source.tasks.add(task)
      outputSources.set(output, source)
    }
    batches.push(batch)
  }
  for (const [projectName, linkedProducts] of projectProducts) {
    checkCancellation()
    let task: string | undefined
    try {
      const project = loaded.projects[projectName]!
      let cwd = roots.get(projectName)!
      const host = await findTypeHost(cwd, project.configFile, signal)
      if (!host && options.automatic)
        continue
      if (host) {
        options.onHost?.()
        cwd = await resolveExistingPath(cwd)
        checkCancellation()
        host.configFile = await resolveExistingPath(host.configFile)
      }
      checkCancellation()
      let expectedScopes: string | undefined
      for (const product of linkedProducts) {
        for (const variant of Object.values(product.variants).filter(variant => variant.project === projectName)) {
          task = `${product.key}:${variant.id}:prepare`
          const effectiveEnv = resolveSchemaEnv({
            ...loaded.config.env,
            ...product.env,
            ...loaded.externalEnv,
          }, loaded.config.envSchema)
          const genericTypes: GenerateMatrixTypesOptions[] = [{
            cwd,
            env: matrixTypeEnvKeys(effectiveEnv),
            ...(loaded.config.envSchema ? { envSchema: loaded.config.envSchema } : {}),
          }]
          if (!host) {
            if (!options.automatic)
              await addBatch(genericTypes, projectName, [task])
            continue
          }
          const identity = resolveProductContext({ config: loaded.config, product, variant, envName: loaded.envName, env: effectiveEnv, projectRoot: cwd })
          // Resolve both real host lifecycles even if this invocation selects only one.
          // Never assume a development/serve resolution covers production/build.
          for (const target of ['dev', 'build'] as const) {
            const configured = variant.targets[target]
            const context = {
              command: target === 'dev' ? 'serve' as const : 'build' as const,
              nodeEnv: configured ? configured.nodeEnv : target === 'dev' ? 'development' : 'production',
            }
            const env = {
              ...effectiveEnv,
              ...identity.env,
              NODE_ENV: context.nodeEnv,
              MATRIX_NODE_ENV: context.nodeEnv,
              MATRIX_ENV_NAME: loaded.envName,
              MATRIX_PROJECT: projectName,
              MATRIX_VARIANT: variant.id,
              MATRIX_TARGET: target,
              [MATRIX_ENV_SCHEMA_KEY]: serializeEnvSchema(loaded.config.envSchema),
            }
            const preparedTypes = await resolveHostTypes(cwd, env, { host, mode: loaded.envName, ...context, automatic: options.automatic ?? false }, signal)
            checkCancellation()
            const scopes = JSON.stringify(preparedTypes?.map(type => [type.cwd, type.scope ?? '']).sort() ?? null)
            if (expectedScopes !== undefined && scopes !== expectedScopes)
              throw new Error(`Matrix scopes change between products, variants, or host contexts in ${cwd}; keep the type contract stable.`)
            expectedScopes = scopes
            await addBatch(preparedTypes ?? (options.automatic ? [] : genericTypes), projectName, [task])
          }
        }
      }
    }
    catch (error) {
      throw preparationError(error, projectName, task)
    }
  }
  const outputs: string[] = []
  checkCancellation()
  for (const declaration of mergePreparedTypes(batches)) {
    checkCancellation()
    const source = outputSources.get(matrixTypeOutput(declaration))!
    try {
      const output = await generateMatrixTypes(declaration, signal)
      outputs.push(output)
      options.onDeclaration?.(declaration)
      onOutput?.(output)
    }
    catch (error) {
      throw preparationError(error, [...source.projects].join(', '), source.tasks.size === 1 ? [...source.tasks][0] : undefined)
    }
    checkCancellation()
  }
  return outputs
}
