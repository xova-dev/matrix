import type { EnvSchema, Scalar } from '../types.js'
import { camelCase } from 'scule'
import { MATRIX_ENV_SCHEMA_KEY, MATRIX_TYPE_CONTRACT_KEY } from '../config/env-schema.js'
import { parseEnvValue } from '../config/schema.js'

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

function publicEnvKeys(env: Record<string, unknown>, prefix: EnvPrefix | undefined = ['VITE_', 'MATRIX_']): string[] {
  const prefixes = normalizeEnvPrefix(prefix)
  return Object.keys(env).filter((key) => {
    if (key.startsWith('MATRIX_') || key === MATRIX_ENV_SCHEMA_KEY || key === MATRIX_TYPE_CONTRACT_KEY || matrixKeys.has(key))
      return false
    return prefixes.some(candidate => key.startsWith(candidate))
  }).sort()
}

function publicEnvConfigName(key: string, prefixes: string[]): string {
  const prefix = prefixes.find(candidate => key.startsWith(candidate))
  return prefix ? camelCase(key.slice(prefix.length).toLowerCase()) : ''
}

/** Nuxt rejects all aliases; other adapters preserve legacy untyped collision order. */
function publicConfigFields(keys: string[], prefixes: string[], schema: EnvSchema, strictPublicFields = false): Map<string, string> {
  const fields = new Map<string, string>()
  for (const key of keys) {
    const name = publicEnvConfigName(key, prefixes)
    if (!name)
      continue
    const previous = fields.get(name)
    if (previous && previous !== key && (strictPublicFields || Object.hasOwn(schema, previous) || Object.hasOwn(schema, key)))
      throw new Error(`Ambiguous environment fields ${previous} and ${key}: both map to matrix.config.${name}`)
    fields.set(name, key)
  }
  return fields
}

/** Preparation bounds exposure; only current env/schema keys participate in value selection. */
export function resolvePublicEnvFields(env: Record<string, unknown>, prefix: EnvPrefix | undefined = ['VITE_', 'MATRIX_'], schema: EnvSchema = {}, strictPublicFields = false, preparedKeys?: string[]): { keys: string[], fields: Map<string, string> } {
  const prefixes = normalizeEnvPrefix(prefix)
  let keys = publicEnvKeys({ ...schema, ...env }, prefixes)
  if (preparedKeys !== undefined) {
    const allowed = new Set(preparedKeys)
    const preparedFields = publicConfigFields(preparedKeys, prefixes, schema, strictPublicFields)
    // Check additions before filtering: an excluded alias must not hide a conflict,
    // even when the corresponding prepared field belongs to another product.
    for (const key of keys) {
      if (allowed.has(key))
        continue
      const name = publicEnvConfigName(key, prefixes)
      const previous = preparedFields.get(name)
      if (previous)
        throw new Error(`Ambiguous environment fields ${previous} and ${key}: both map to matrix.config.${name}`)
    }
    keys = keys.filter(key => allowed.has(key))
  }
  return { keys, fields: publicConfigFields(keys, prefixes, schema, strictPublicFields) }
}

export function createPublicConfig(env: Record<string, string>, prefix: EnvPrefix | undefined = ['VITE_', 'MATRIX_'], schema: EnvSchema = {}, strictPublicFields = false, preparedKeys?: string[]): Record<string, Scalar> {
  const config: Record<string, Scalar> = {}
  const { fields } = resolvePublicEnvFields(env, prefix, schema, strictPublicFields, preparedKeys)
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
