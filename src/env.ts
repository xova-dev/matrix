import type { EnvSchema, Scalar } from './types.js'
import { camelCase } from 'scule'
import { MATRIX_ENV_SCHEMA_KEY } from './env-schema.js'
import { parseEnvValue } from './schema.js'

export type EnvPrefix = string | string[]

const matrixKeys = new Set([
  'MATRIX_ENV_NAME',
  'MATRIX_TARGET',
  'MATRIX_PRODUCT_KEY',
  'MATRIX_PRODUCT_ID',
  'MATRIX_PRODUCT_NAME',
  'MATRIX_PRODUCT_SLUG',
  'MATRIX_PRODUCT_APP_ID',
  'MATRIX_VARIANT',
  'MATRIX_PROJECT',
  'NODE_ENV',
])

export function normalizeEnvPrefix(prefix: EnvPrefix | undefined): string[] {
  if (prefix === undefined)
    return ['VITE_']
  return Array.isArray(prefix) ? prefix : [prefix]
}

export function ensureMatrixEnvPrefix(prefix: EnvPrefix | undefined): string[] {
  return [...new Set([...normalizeEnvPrefix(prefix), 'MATRIX_'])]
}

export function publicEnvKeys(env: Record<string, unknown>, prefix: EnvPrefix | undefined = ['VITE_', 'MATRIX_']): string[] {
  const prefixes = normalizeEnvPrefix(prefix)
  return Object.keys(env).filter((key) => {
    if (key.startsWith('MATRIX_') || key === MATRIX_ENV_SCHEMA_KEY || matrixKeys.has(key))
      return false
    return prefixes.some(candidate => key.startsWith(candidate))
  }).sort()
}

export function publicEnvConfigName(key: string, prefixes: string[]): string {
  const prefix = prefixes.find(candidate => key.startsWith(candidate))
  return prefix ? camelCase(key.slice(prefix.length).toLowerCase()) : ''
}

/** Typed fields must have an unambiguous public property; legacy collisions keep their order. */
export function publicConfigFields(keys: string[], prefixes: string[], schema: EnvSchema): Map<string, string> {
  const fields = new Map<string, string>()
  for (const key of keys) {
    const name = publicEnvConfigName(key, prefixes)
    if (!name)
      continue
    const previous = fields.get(name)
    if (previous && (Object.hasOwn(schema, previous) || Object.hasOwn(schema, key)))
      throw new Error(`Ambiguous environment fields ${previous} and ${key}: both map to matrix.config.${name}`)
    fields.set(name, key)
  }
  return fields
}

export function createPublicConfig(env: Record<string, string>, prefix: EnvPrefix | undefined = ['VITE_', 'MATRIX_'], schema: EnvSchema = {}): Record<string, Scalar> {
  const prefixes = normalizeEnvPrefix(prefix)
  const config: Record<string, Scalar> = {}
  const fields = publicConfigFields(publicEnvKeys({ ...schema, ...env }, prefixes), prefixes, schema)
  for (const [name, key] of fields) {
    const field = Object.hasOwn(schema, key) ? schema[key] : undefined
    const value = Object.hasOwn(env, key) ? env[key] : field?.default
    if (value === undefined) {
      if (field && !field.optional)
        throw new Error(`Missing required environment field ${key}`)
      continue
    }
    config[name] = field ? parseEnvValue(key, field, value) : value
  }
  return config
}
