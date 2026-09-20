import * as v from 'valibot'

const scalar = v.union([v.string(), v.number(), v.boolean()])
const env = v.optional(v.record(v.string(), scalar))
const suffix = v.object({ name: v.optional(v.string()), slug: v.optional(v.string()), appId: v.optional(v.string()) })
const targetDependency = v.object({ variant: v.string(), target: v.optional(v.string()), condition: v.optional(v.picklist(['completed', 'ready'])) })
const dependency = v.union([v.string(), targetDependency])
const readyPort = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535))
const readyTimeout = v.pipe(v.number(), v.integer(), v.minValue(1))
const target = v.union([v.string(), v.object({
  command: v.string(),
  continuous: v.optional(v.boolean()),
  readyWhen: v.optional(v.object({ type: v.literal('port'), host: v.optional(v.string()), port: readyPort, timeout: v.optional(readyTimeout) })),
  outputDir: v.optional(v.string()),
  archive: v.optional(v.union([v.boolean(), v.object({ enabled: v.boolean(), format: v.optional(v.picklist(['zip', 'tar.gz'])) })])),
  dependsOn: v.optional(v.array(dependency)),
})])
const targetOverride = v.union([v.string(), v.object({
  command: v.optional(v.string()),
  continuous: v.optional(v.boolean()),
  readyWhen: v.optional(v.object({ type: v.literal('port'), host: v.optional(v.string()), port: readyPort, timeout: v.optional(readyTimeout) })),
  outputDir: v.optional(v.string()),
  archive: v.optional(v.union([v.boolean(), v.object({ enabled: v.boolean(), format: v.optional(v.picklist(['zip', 'tar.gz'])) })])),
  dependsOn: v.optional(v.array(dependency)),
})])
const project = v.object({ root: v.optional(v.string()), targets: v.record(v.string(), target) })
const environment = v.object({ env })
const variant = v.union([v.string(), v.object({
  project: v.string(),
  name: v.optional(v.string()),
  slug: v.optional(v.string()),
  appId: v.optional(v.string()),
  suffixes: v.optional(v.record(v.string(), suffix)),
  targets: v.optional(v.record(v.string(), targetOverride)),
})])
const product = v.object({
  id: v.optional(v.string()),
  name: v.optional(v.string()),
  slug: v.optional(v.string()),
  appId: v.optional(v.string()),
  env,
  $env: v.optional(v.record(v.string(), environment)),
  suffixes: v.optional(v.record(v.string(), suffix)),
  variants: v.record(v.string(), variant),
})
/** Runtime schema used to validate a loaded Matrix configuration. */
export const matrixConfigSchema = v.object({
  suffixes: v.optional(v.record(v.string(), suffix)),
  env,
  $env: v.optional(v.record(v.string(), environment)),
  projects: v.record(v.string(), project),
  products: v.record(v.string(), product),
  artifacts: v.optional(v.object({ root: v.optional(v.string()) })),
})

/** Validates a configuration and throws a Valibot error when it is malformed. */
export function assertMatrixConfig(value: unknown): v.InferOutput<typeof matrixConfigSchema> {
  return v.parse(matrixConfigSchema, value)
}
