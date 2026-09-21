/** Values that can be passed to a process as environment variables. */
export type Scalar = string | number | boolean

/** Node.js runtime mode exported as `NODE_ENV` for child processes. */
export type NodeEnvironment = 'development' | 'production' | 'test'

/** A flat environment variable map. */
export type EnvMap = Record<string, Scalar>

/** Configuration for a project command such as `dev`, `build`, or `preview`. */
export interface CommandTarget {
  /** Command to execute from the project's root directory. */
  command: string | string[]
  /** Whether the command keeps running after it starts. Defaults from the target name. */
  continuous?: boolean
  /** Node.js runtime mode passed to the target process. */
  nodeEnv?: NodeEnvironment
  /** Readiness probe used by dependent continuous targets. */
  readyWhen?: {
    /** Probe type. Port probing is currently supported. */
    type: 'port'
    /** Host to probe. Defaults to the local host used by the probe. */
    host?: string
    /** TCP port that must accept a connection. */
    port: number
    /** Maximum time to wait for readiness, in milliseconds. */
    timeout?: number
  }
  /** Directory containing completed output, relative to the project root. Defaults to `dist`. */
  outputDir?: string
  /** How completed output should be materialized as an artifact. */
  artifacts?: ArtifactConfig
  /** Other variants that must run before this target. */
  dependsOn?: Array<string | TargetDependency>
}

/** Short target syntax containing only the command. */
export type TargetConfig = string | string[] | CommandTarget

/** Partial target configuration used to override a project's target on a variant. */
export type TargetOverride = string | string[] | Partial<CommandTarget>

export interface ArtifactConfig {
  mode?: 'move' | 'archive' | 'both'
  format?: 'zip' | 'tar.gz'
  /** Whether to clear the target output directory before execution. */
  clean?: boolean
}

/** Dependency on another variant of the same product. */
export interface TargetDependency {
  /** Variant that must be executed first. */
  variant: string
  /** Target to execute on the dependency. Defaults to the current target. */
  target?: string
  /** Dependency condition. Defaults to `ready` for continuous targets and `completed` otherwise. */
  condition?: 'completed' | 'ready'
}

/** A runnable project and the targets it exposes. */
export interface ProjectConfig {
  /** Project directory, relative to the Matrix configuration directory. Defaults to `.`. */
  root?: string
  /** Named commands exposed by this project. */
  targets: Record<string, TargetConfig>
}

/** Configuration for a product variant, or a project name in short form. */
export type VariantConfig = string | {
  /** Project used to implement this variant. */
  project: string
  /** Display name used in generated task metadata. */
  name?: string
  /** Slug used in generated task metadata. */
  slug?: string
  /** Application identifier used in generated task metadata. */
  appId?: string
  /** Environment-specific identity suffixes for this variant. */
  suffixes?: Record<string, SuffixConfig>
  /** Target overrides or additional targets for this variant. */
  targets?: Record<string, TargetOverride>
}

/** Environment-specific suffixes for a product or variant identity. */
export interface SuffixConfig {
  /** Text appended to the display name. */
  name?: string
  /** Text appended to the slug. */
  slug?: string
  /** Text appended to the application identifier. */
  appId?: string
}

/** A product groups variants that are selected and executed together. */
export interface ProductConfig {
  /** Stable product identifier. Defaults to the product key. */
  id?: string
  /** Display name. Defaults to the product key. */
  name?: string
  /** Slug. Defaults to the product key. */
  slug?: string
  /** Base application identifier. */
  appId?: string
  /** Base environment variables for every environment. */
  env?: EnvMap
  /** Product-scoped environment overrides loaded by c12's `$env` mechanism. */
  $env?: Record<string, EnvironmentConfig>
  /** Environment-specific identity suffixes. */
  suffixes?: Record<string, SuffixConfig>
  /** Product variants. */
  variants: Record<string, VariantConfig>
}

/** Configuration for one named environment. */
export interface EnvironmentConfig {
  /** Environment variables merged over the parent scope. */
  env?: EnvMap
}

/** Root Matrix configuration. */
export interface MatrixConfig {
  /** Global environment-specific identity suffixes. */
  suffixes?: Record<string, SuffixConfig>
  /** Base environment variables shared by all products. */
  env?: EnvMap
  /** Global environment overrides loaded by c12's `$env` mechanism. */
  $env?: Record<string, EnvironmentConfig>
  /** Reusable projects. */
  projects: Record<string, ProjectConfig>
  /** Products composed from the projects above. */
  products: Record<string, ProductConfig>
  /** Output artifact configuration. */
  artifacts?: { root?: string, retention?: { keep?: number } }
}

/** Built-in environment names offered by Matrix. Custom names can be added with `$env`. */
export const MATRIX_ENVIRONMENTS = ['development', 'staging', 'production'] as const

/** A built-in Matrix environment name. */
export type MatrixEnvironment = typeof MATRIX_ENVIRONMENTS[number]

/** Target after defaults and variant overrides have been resolved. */
export type NormalizedTarget = Omit<CommandTarget, 'outputDir' | 'dependsOn' | 'artifacts'> & { name: string, continuous: boolean, nodeEnv: NodeEnvironment, outputDir: string, artifacts: { mode: 'move' | 'archive' | 'both' | 'none', format: 'zip' | 'tar.gz', clean: boolean }, dependsOn: TargetDependency[] }

/** Project after its target definitions have been normalized. */
export type NormalizedProject = Omit<ProjectConfig, 'targets'> & { id: string, targets: Record<string, NormalizedTarget> }

/** Variant after its project targets and overrides have been normalized. */
export type NormalizedVariant = Omit<Exclude<VariantConfig, string>, 'targets'> & { id: string, project: string, targets: Record<string, NormalizedTarget> }

/** Product after identity defaults and variant definitions have been normalized. */
export type NormalizedProduct = Omit<ProductConfig, 'variants' | 'id' | 'name' | 'slug'> & { id: string, name: string, slug: string, key: string, variants: Record<string, NormalizedVariant> }

/** One executable task in an {@link ExecutionPlan}. */
export interface ExecutionTask {
  /** Stable task identifier. */
  id: string
  /** Product key that owns the task. */
  product: string
  /** Variant key that owns the task. */
  variant: string
  /** Referenced project key. */
  project: string
  /** Absolute project directory. */
  projectRoot: string
  /** Target name. */
  target: string
  /** Resolved display name. */
  name: string
  /** Resolved slug. */
  slug: string
  /** Resolved application identifier, when configured. */
  appId?: string
  /** Command or ordered commands to execute. */
  command: string | string[]
  /** Working directory for the command. */
  cwd: string
  /** Environment passed to the command. */
  env: EnvMap
  /** Whether the command is expected to remain running. */
  continuous: boolean
  /** Resolved artifact settings. */
  artifacts: { mode: 'move' | 'archive' | 'both' | 'none', format: 'zip' | 'tar.gz', clean: boolean }
  /** Readiness probe, when configured. */
  readyWhen?: { type: 'port', host?: string, port: number, timeout?: number }
  /** Absolute output directory. */
  outputDir: string
  /** Resolved task dependencies and their completion conditions. */
  dependsOn: Array<{ id: string, condition: 'completed' | 'ready' }>
}

/** Ordered executable tasks and their shared artifact destination. */
export interface ExecutionPlan {
  /** Environment selected for this plan. */
  envName: string
  /** Tasks in dependency-safe execution order. */
  tasks: ExecutionTask[]
  /** Absolute root directory for generated artifacts. */
  artifactsRoot: string
  artifactRetention: number
}

/** Input accepted by {@link createExecutionPlan}. */
export interface CreateExecutionPlanInput {
  /** Resolved root-level configuration values used by planning. */
  config: { artifacts?: { root?: string, retention?: { keep?: number } }, env?: EnvMap, suffixes?: Record<string, SuffixConfig> }
  /** Normalized projects keyed by project name. */
  projects: Record<string, { root?: string }>
  /** Normalized products keyed by product name. */
  products: Record<string, NormalizedProduct>
  /** External process environment to merge into each task. */
  externalEnv?: EnvMap
  /** Directory containing the Matrix configuration. */
  cwd: string
  /** Products to include in the plan. */
  productNames: string[]
  /** Optional variant filter. */
  variantNames?: string[]
  /** Target to execute for each selected variant. */
  target: string
  /** Environment used to resolve identity suffixes. */
  envName: string
}
