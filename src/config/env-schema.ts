import type { EnvMap, EnvSchema } from '../types.js'
import { assertEnvSchema, parseEnvValue } from './schema.js'

/** Not MATRIX_-prefixed: Vite must not expose schema metadata through import.meta.env. */
export const MATRIX_ENV_SCHEMA_KEY = '__MATRIX_ENV_SCHEMA'

/** CLI validation never requires absent fields from unrelated build prefixes. */
export function resolveSchemaEnv(env: EnvMap, schema?: EnvSchema): EnvMap {
  if (!schema)
    return env
  assertEnvSchema(schema)
  const result = { ...env }
  for (const [key, field] of Object.entries(schema)) {
    const value = Object.hasOwn(env, key) ? env[key] : field.default
    if (value !== undefined)
      result[key] = String(parseEnvValue(key, field, value))
  }
  return result
}

/** Defaults are already resolved in task env; do not transport their values as metadata. */
export function serializeEnvSchema(schema?: EnvSchema): string {
  return JSON.stringify(Object.fromEntries(Object.entries(schema ?? {}).map(([key, field]) => [key, {
    type: field.type,
    optional: field.optional === true && field.default === undefined,
    ...(field.type === 'enum' ? { values: field.values } : {}),
  }])))
}

export function readEnvSchema(env: Record<string, unknown>): EnvSchema {
  const value = env[MATRIX_ENV_SCHEMA_KEY]
  if (value === undefined)
    return {}
  try {
    return assertEnvSchema(JSON.parse(String(value)))
  }
  catch {
    throw new Error('Invalid Matrix internal environment schema')
  }
}
