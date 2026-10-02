import type { EnvSchema } from '../types.js'
import type { MatrixRuntime } from './index.js'
import type { EnvPrefix } from './public-env.js'
import { readEnvSchema } from '../config/env-schema.js'
import { createPublicConfig, normalizeEnvPrefix } from './public-env.js'

export function createMatrixRuntime(env: Record<string, string>, envPrefix: EnvPrefix | undefined = ['VITE_', 'MATRIX_'], envSchema: EnvSchema = readEnvSchema(env)): MatrixRuntime {
  const prefixes = normalizeEnvPrefix(envPrefix)
  // Vite's config.env only contains prefixed variables, so keep a Matrix-prefixed
  // snapshot as a fallback while preserving NODE_ENV for the child process.
  const nodeEnv = env.NODE_ENV ?? env.MATRIX_NODE_ENV ?? ''
  const isProduction = nodeEnv === 'production'
  return Object.freeze({
    environment: env.MATRIX_ENV_NAME ?? '',
    target: env.MATRIX_TARGET ?? '',
    nodeEnv,
    isDevelopment: !isProduction,
    isProduction,
    isTest: nodeEnv === 'test',
    variant: env.MATRIX_VARIANT ?? '',
    project: env.MATRIX_PROJECT ?? '',
    product: Object.freeze({
      key: env.MATRIX_PRODUCT_KEY ?? '',
      id: env.MATRIX_PRODUCT_ID ?? '',
      name: env.MATRIX_PRODUCT_NAME ?? '',
      slug: env.MATRIX_PRODUCT_SLUG ?? '',
      ...(env.MATRIX_PRODUCT_APP_ID ? { appId: env.MATRIX_PRODUCT_APP_ID } : {}),
      ...(env.MATRIX_PRODUCT_VERSION ? { version: env.MATRIX_PRODUCT_VERSION } : {}),
    }),
    config: Object.freeze(createPublicConfig(env, prefixes, envSchema)),
  })
}

function runtimeExpression(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, field]) => `[${JSON.stringify(key)}]:${runtimeExpression(field)}`).join(',')}}`
  }
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}

export function runtimeModule(runtime: MatrixRuntime): string {
  // Computed keys preserve own properties such as __proto__. The pure initializer only
  // constructs this snapshot, so unused static-only imports can disappear.
  return [
    'export const matrix = /* @__PURE__ */ (() => {',
    `const snapshot = ${runtimeExpression(runtime)};`,
    'Object.freeze(snapshot.product);',
    'Object.freeze(snapshot.config);',
    'return Object.freeze(snapshot);',
    '})();',
  ].join('\n')
}
