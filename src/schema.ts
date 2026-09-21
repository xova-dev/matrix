import * as v from 'valibot'

const scalar = v.union([v.string(), v.number(), v.boolean()])
const env = v.optional(v.record(v.string(), scalar))
const suffix = v.object({ name: v.optional(v.string()), slug: v.optional(v.string()), appId: v.optional(v.string()) })
const targetDependency = v.object({ variant: v.string(), target: v.optional(v.string()), condition: v.optional(v.picklist(['completed', 'ready'])) })
const dependency = v.union([v.string(), targetDependency])
const readyPort = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535))
const readyTimeout = v.pipe(v.number(), v.integer(), v.minValue(1))
const command = v.union([v.string(), v.pipe(v.array(v.string()), v.minLength(1))])
const artifactConfig = v.object({
  mode: v.optional(v.picklist(['move', 'archive', 'both'])),
  format: v.optional(v.picklist(['zip', 'tar.gz'])),
  removeSource: v.optional(v.boolean()),
})
const target = v.union([command, v.object({
  command,
  continuous: v.optional(v.boolean()),
  nodeEnv: v.optional(v.picklist(['development', 'production', 'test'])),
  readyWhen: v.optional(v.object({ type: v.literal('port'), host: v.optional(v.string()), port: readyPort, timeout: v.optional(readyTimeout) })),
  outputDir: v.optional(v.string()),
  artifacts: v.optional(artifactConfig),
  dependsOn: v.optional(v.array(dependency)),
})])
const targetOverride = v.union([v.string(), command, v.object({
  command: v.optional(command),
  continuous: v.optional(v.boolean()),
  nodeEnv: v.optional(v.picklist(['development', 'production', 'test'])),
  readyWhen: v.optional(v.object({ type: v.literal('port'), host: v.optional(v.string()), port: readyPort, timeout: v.optional(readyTimeout) })),
  outputDir: v.optional(v.string()),
  artifacts: v.optional(artifactConfig),
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
  artifacts: v.optional(v.object({ root: v.optional(v.string()), retention: v.optional(v.object({ keep: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))) })) })),
})

/** Validates a configuration and throws a Valibot error when it is malformed. */
export function assertMatrixConfig(value: unknown): v.InferOutput<typeof matrixConfigSchema> {
  return v.parse(matrixConfigSchema, value)
}
