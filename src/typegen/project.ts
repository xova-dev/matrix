import type { loadMatrixConfig } from '../config/index.js'
import type { EnvMap } from '../types.js'
import type { GenerateMatrixTypesOptions } from './generate.js'
import path from 'node:path'
import { MATRIX_DEFAULTS } from '../config/defaults.js'
import { MATRIX_ENV_SCHEMA_KEY, resolveSchemaEnv, serializeEnvSchema } from '../config/env-schema.js'
import { resolveProductContext } from '../product/context.js'
import { generateMatrixTypes, matrixTypeEnvKeys } from './generate.js'
import { findTypeHost, mergePreparedTypes, resolveHostTypes } from './prepare.js'

type Products = Awaited<ReturnType<typeof loadMatrixConfig>>['products']
type Product = Products[string]
type LoadedConfig = Awaited<ReturnType<typeof loadMatrixConfig>>

export async function generateProjectTypes(loaded: LoadedConfig, products: Product[]): Promise<string[]> {
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
