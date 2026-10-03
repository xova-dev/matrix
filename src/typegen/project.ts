import type { loadMatrixConfig } from '../config/index.js'
import type { EnvMap } from '../types.js'
import type { GenerateMatrixTypesOptions } from './generate.js'
import { MATRIX_DEFAULTS } from '../config/defaults.js'
import { MATRIX_ENV_SCHEMA_KEY, resolveSchemaEnv, serializeEnvSchema } from '../config/env-schema.js'
import { resolveProductContext } from '../product/context.js'
import { resolveExistingPath, resolveFilesystemPath } from '../utils/path.js'
import { generateMatrixTypes, matrixTypeEnvKeys, matrixTypeOutput } from './generate.js'
import { findTypeHost, mergePreparedTypes, resolveHostTypes, TypePreparationCancelled } from './prepare.js'

type Products = Awaited<ReturnType<typeof loadMatrixConfig>>['products']
type Product = Products[string]
type LoadedConfig = Awaited<ReturnType<typeof loadMatrixConfig>>

export class ProjectTypePreparationError extends Error {
  constructor(error: unknown, readonly project: string, readonly task?: string) {
    super(error instanceof Error ? error.message : 'Unable to generate project types', { cause: error })
  }
}

export async function generateProjectTypes(loaded: LoadedConfig, products: Product[], options: { onOutput?: (output: string) => void, signal?: AbortSignal } = {}): Promise<string[]> {
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
  const outputSources = new Map<string, { projects: Set<string>, tasks: Set<string> }>()
  const addBatch = (batch: GenerateMatrixTypesOptions[], project: string, tasks: string[]): void => {
    for (const declaration of batch) {
      const output = matrixTypeOutput(declaration)
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
      let cwd = resolveFilesystemPath(loaded.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot)
      const host = await findTypeHost(cwd, project.configFile, signal)
      if (host) {
        cwd = await resolveExistingPath(cwd)
        checkCancellation()
        host.configFile = await resolveExistingPath(host.configFile)
      }
      checkCancellation()
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
            task = `${product.key}:${variant.id}:prepare`
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
            const preparedTypes = await resolveHostTypes(cwd, env, { host, mode: loaded.envName }, signal)
            checkCancellation()
            const scopes = JSON.stringify(preparedTypes?.map(type => [type.cwd, type.scope ?? '']).sort() ?? null)
            if (expectedScopes !== undefined && scopes !== expectedScopes)
              throw new Error(`Matrix scopes change between products or variants in ${cwd}; keep the type contract stable.`)
            expectedScopes = scopes
            addBatch(preparedTypes ?? genericTypes, projectName, [task])
          }
        }
        continue
      }
      addBatch(genericTypes, projectName, linkedProducts.flatMap(product => Object.values(product.variants)
        .filter(variant => variant.project === projectName)
        .map(variant => `${product.key}:${variant.id}:prepare`)))
    }
    catch (error) {
      throw preparationError(error, projectName, task)
    }
  }
  const outputs: string[] = []
  checkCancellation()
  for (const options of mergePreparedTypes(batches)) {
    checkCancellation()
    const source = outputSources.get(matrixTypeOutput(options))!
    try {
      const output = await generateMatrixTypes(options, signal)
      outputs.push(output)
      onOutput?.(output)
    }
    catch (error) {
      throw preparationError(error, [...source.projects].join(', '), source.tasks.size === 1 ? [...source.tasks][0] : undefined)
    }
    checkCancellation()
  }
  return outputs
}
