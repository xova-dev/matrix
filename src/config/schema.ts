import type { EnvField, EnvSchema, Scalar } from '../types.js'
import * as v from 'valibot'

/** Parse a value without including it (or enum choices) in diagnostic messages. */
export function parseEnvValue(key: string, field: EnvField, value: unknown): Scalar {
  if (field.type === 'string' && typeof value === 'string')
    return value
  if (field.type === 'enum' && typeof value === 'string' && field.values.includes(value))
    return value
  if (field.type === 'boolean') {
    if (typeof value === 'boolean')
      return value
    if (value === 'true' || value === 'false')
      return value === 'true'
  }
  if (field.type === 'number') {
    if (typeof value === 'number' && Number.isFinite(value))
      return value
    if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && value === value.trim() && Number.isFinite(Number(value)))
      return Number(value)
  }
  throw new Error(`Invalid environment field ${key}: expected ${field.type}`)
}

/** Kept dependency-free apart from types so the isolated config worker can load this module. */
export function assertEnvSchema(value: unknown): EnvSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid envSchema: expected a flat field map')
  for (const [key, declaration] of Object.entries(value)) {
    if (!/^[a-z_]\w*$/i.test(key) || key !== key.trim() || key.startsWith('MATRIX_') || key.startsWith('__MATRIX_') || ['NODE_ENV', '__proto__', 'constructor', 'prototype'].includes(key))
      throw new Error('Invalid or reserved envSchema field name')
    const invalid = (): never => {
      throw new Error(`Invalid envSchema declaration for ${key}`)
    }
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration))
      invalid()
    const field = declaration as Record<string, unknown>
    if (!['string', 'number', 'boolean', 'enum'].includes(String(field.type)))
      invalid()
    if (Object.keys(field).some(key => !['type', 'optional', 'default', ...(field.type === 'enum' ? ['values'] : [])].includes(key)))
      invalid()
    if (field.optional !== undefined && typeof field.optional !== 'boolean')
      invalid()
    if (field.type === 'enum' && (!Array.isArray(field.values) || !field.values.length || field.values.some(value => typeof value !== 'string')))
      invalid()
    if (field.default !== undefined) {
      if ((field.type === 'boolean' && typeof field.default !== 'boolean')
        || (field.type === 'number' && typeof field.default !== 'number')
        || ((field.type === 'enum' || field.type === 'string') && typeof field.default !== 'string')) {
        invalid()
      }
      parseEnvValue(key, field as EnvField, field.default)
    }
  }
  return value as EnvSchema
}

/** SemVer without prefixes, whitespace, or numeric prerelease leading zeroes. */
export function isReleaseVersion(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i.test(value)
}

const scalar = v.union([v.string(), v.number(), v.boolean()])
const env = v.optional(v.record(v.string(), scalar))
const version = v.optional(v.pipe(v.string(), v.check(value => isReleaseVersion(value), 'Expected a SemVer release version')))
const suffix = v.object({ name: v.optional(v.string()), slug: v.optional(v.string()), appId: v.optional(v.string()) })
const targetDependency = v.object({ variant: v.string(), target: v.optional(v.string()), condition: v.optional(v.picklist(['completed', 'ready'])) })
const dependency = v.union([v.string(), targetDependency])
const readyPort = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535))
const readyTimeout = v.pipe(v.number(), v.integer(), v.minValue(1))
const commandString = v.pipe(v.string(), v.check(value => Boolean(value.trim()), 'Commands must be non-empty'))
const command = v.union([commandString, v.pipe(v.array(commandString), v.minLength(1))])
const artifactConfig = v.object({
  mode: v.optional(v.picklist(['move', 'archive', 'both'])),
  format: v.optional(v.picklist(['zip', 'tar.gz'])),
  clean: v.optional(v.boolean()),
})
const target = v.union([command, v.object({
  command,
  prepare: v.optional(v.boolean()),
  continuous: v.optional(v.boolean()),
  nodeEnv: v.optional(v.picklist(['development', 'production', 'test'])),
  readyWhen: v.optional(v.object({ type: v.literal('port'), host: v.optional(v.string()), port: readyPort, timeout: v.optional(readyTimeout) })),
  outputDir: v.optional(v.string()),
  artifacts: v.optional(artifactConfig),
  dependsOn: v.optional(v.array(dependency)),
})])
const targetOverride = v.union([command, v.object({
  command: v.optional(command),
  prepare: v.optional(v.boolean()),
  continuous: v.optional(v.boolean()),
  nodeEnv: v.optional(v.picklist(['development', 'production', 'test'])),
  readyWhen: v.optional(v.object({ type: v.literal('port'), host: v.optional(v.string()), port: readyPort, timeout: v.optional(readyTimeout) })),
  outputDir: v.optional(v.string()),
  artifacts: v.optional(artifactConfig),
  dependsOn: v.optional(v.array(dependency)),
})])
const project = v.object({
  root: v.optional(v.string()),
  configFile: v.optional(v.pipe(v.string(), v.check(value => value.trim().length > 0, 'configFile must not be empty'))),
  prepare: v.optional(command),
  targets: v.record(v.string(), target),
})
const environment = v.object({ env })
const variant = v.union([v.string(), v.object({
  project: v.string(),
  name: v.optional(v.string()),
  slug: v.optional(v.string()),
  appId: v.optional(v.string()),
  version,
  suffixes: v.optional(v.record(v.string(), suffix)),
  targets: v.optional(v.record(v.string(), targetOverride)),
})])
const product = v.object({
  id: v.optional(v.string()),
  name: v.optional(v.string()),
  slug: v.optional(v.string()),
  appId: v.optional(v.string()),
  version,
  env,
  $env: v.optional(v.record(v.string(), environment)),
  suffixes: v.optional(v.record(v.string(), suffix)),
  variants: v.record(v.string(), variant),
})
/** Runtime schema used to validate a loaded Matrix configuration. */
export const matrixConfigSchema = v.object({
  envSchema: v.optional(v.pipe(v.unknown(), v.transform(assertEnvSchema))),
  suffixes: v.optional(v.record(v.string(), suffix)),
  env,
  $env: v.optional(v.record(v.string(), environment)),
  projects: v.record(v.string(), project),
  products: v.record(v.string(), product),
  artifacts: v.optional(v.object({ root: v.optional(v.string()), retention: v.optional(v.object({ keep: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))) })) })),
})

/** Validates a configuration and throws a Valibot error when it is malformed. */
export function assertMatrixConfig(value: unknown): v.InferOutput<typeof matrixConfigSchema> {
  return v.parse(matrixConfigSchema, value)
}
