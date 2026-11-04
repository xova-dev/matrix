import type { EnvMap, MatrixConfig, NodeEnvironment, NormalizedProduct, NormalizedVariant } from '../types.js'
import { resolveSchemaEnv } from '../config/env-schema.js'
import { readPackageVersion, validateReleaseVersion } from './version.js'

function applySuffix(value: string | undefined, suffix: string | undefined): string | undefined {
  return value === undefined || suffix === undefined ? value : `${value}${suffix}`
}

/** Resolve one immutable context for preparation, host resolution and commands. */
export function resolveExecutionContext(input: Omit<ProductContextInput, 'env'> & {
  config: Pick<MatrixConfig, 'suffixes' | 'env' | 'envSchema'>
  externalEnv: EnvMap
  nodeEnv: NodeEnvironment
}): ReturnType<typeof resolveProductContext> & { env: EnvMap & { NODE_ENV: NodeEnvironment } } {
  const effectiveEnv = resolveSchemaEnv({
    ...input.config.env,
    ...input.product.env,
    ...input.externalEnv,
  }, input.config.envSchema)
  const identity = resolveProductContext({ ...input, env: effectiveEnv })
  return {
    ...identity,
    env: {
      ...effectiveEnv,
      ...identity.env,
      MATRIX_ENV_NAME: input.envName,
      MATRIX_PROJECT: input.variant.project,
      MATRIX_VARIANT: input.variant.id,
      MATRIX_TARGET: input.targetName ?? 'prepare',
      MATRIX_NODE_ENV: input.nodeEnv,
      NODE_ENV: input.nodeEnv,
    },
  }
}

function envString(env: EnvMap, key: string): string | undefined {
  const value = env[key]
  return value === undefined ? undefined : String(value)
}

interface ProductContextInput {
  config: Pick<MatrixConfig, 'suffixes'>
  product: NormalizedProduct
  variant: NormalizedVariant
  envName: string
  env: EnvMap
  projectRoot: string
  requiredVersion?: boolean
  targetName?: string
}

/** Shared product identity and version contract for execution and host type preparation. */
export function resolveProductContext({ config, product, variant, envName, env, projectRoot, requiredVersion = false, targetName = 'prepare' }: ProductContextInput): { id: string, name: string, slug: string, appId: string | undefined, version: string | undefined, env: EnvMap } {
  const suffix = { ...config.suffixes?.[envName], ...product.suffixes?.[envName], ...variant.suffixes?.[envName] }
  const name = envString(env, 'MATRIX_PRODUCT_NAME') ?? variant.name ?? product.name
  const slug = envString(env, 'MATRIX_PRODUCT_SLUG') ?? variant.slug ?? product.slug
  const appId = envString(env, 'MATRIX_PRODUCT_APP_ID') ?? variant.appId ?? product.appId
  const identity = {
    id: product.id,
    name: applySuffix(name, suffix.name)!,
    slug: applySuffix(slug, suffix.slug)!,
    appId: applySuffix(appId, suffix.appId),
  }
  const configuredVersion = env.MATRIX_PRODUCT_VERSION ?? variant.version ?? product.version
  const version = configuredVersion === undefined
    ? readPackageVersion(projectRoot, requiredVersion)
    : validateReleaseVersion(configuredVersion, `${product.key}:${variant.id}:${targetName} release version (MATRIX_PRODUCT_VERSION / variant.version / product.version)`)
  return {
    ...identity,
    version,
    env: {
      MATRIX_PRODUCT_KEY: product.key,
      MATRIX_PRODUCT_ID: identity.id,
      MATRIX_PRODUCT_NAME: identity.name,
      MATRIX_PRODUCT_SLUG: identity.slug,
      ...(identity.appId ? { MATRIX_PRODUCT_APP_ID: identity.appId } : {}),
      ...(version === undefined ? {} : { MATRIX_PRODUCT_VERSION: version }),
    },
  }
}
