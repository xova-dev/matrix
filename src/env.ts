import { camelCase } from 'scule'

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
    if (key.startsWith('MATRIX_') || matrixKeys.has(key))
      return false
    return prefixes.some(candidate => key.startsWith(candidate))
  }).sort()
}

export function publicEnvConfigName(key: string, prefixes: string[]): string {
  const prefix = prefixes.find(candidate => key.startsWith(candidate))
  return prefix ? camelCase(key.slice(prefix.length).toLowerCase()) : ''
}

export function createPublicConfig(env: Record<string, string>, prefix: EnvPrefix | undefined = ['VITE_', 'MATRIX_']): Record<string, string> {
  const prefixes = normalizeEnvPrefix(prefix)
  const config: Record<string, string> = {}
  for (const key of publicEnvKeys(env, prefixes)) {
    const name = publicEnvConfigName(key, prefixes)
    if (name)
      config[name] = env[key]!
  }
  return config
}
