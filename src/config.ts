import type { CommandTarget, EnvMap, MatrixConfig, NormalizedProduct, NormalizedProject, NormalizedTarget, NormalizedVariant, TargetConfig, TargetOverride } from './types.js'
import path from 'node:path'
import process from 'node:process'
import { evaluateConfig } from './config-loader.js'
import { MATRIX_DEFAULTS } from './defaults.js'
import { MATRIX_ENVIRONMENTS } from './types.js'

export { defaultEnvironmentForTarget, MATRIX_DEFAULTS } from './defaults.js'

/**
 * Provides type inference for a Matrix configuration file.
 *
 * @example
 * ```ts
 * export default defineMatrixConfig({
 *   projects: { web: { targets: { build: 'pnpm build' } } },
 *   products: { app: { variants: { web: 'web' } } },
 * })
 * ```
 */
export function defineMatrixConfig<T extends MatrixConfig>(config: T): T {
  return config
}

/**
 * Converts a compact environment map into c12's `$env` configuration shape.
 *
 * @example
 * ```ts
 * $env: defineMatrixEnv({
 *   qa: { API_BASE_URL: 'https://qa.example.test' },
 * })
 * ```
 */
export function defineMatrixEnv<T extends Record<string, EnvMap>>(environments: T): { [K in keyof T]: { env: T[K] } } {
  return Object.fromEntries(Object.entries(environments).map(([name, env]) => [name, { env }])) as { [K in keyof T]: { env: T[K] } }
}

/** List declared environments without applying $env layers in an isolated evaluation. */
export async function listMatrixEnvironments(options: { cwd?: string, configFile?: string, productName?: string, envName?: string, signal?: AbortSignal } = {}): Promise<string[]> {
  const declared = await evaluateConfig({
    ...options,
    cwd: path.resolve(options.cwd ?? process.cwd()),
    envName: options.envName ?? MATRIX_DEFAULTS.environment,
    discover: true,
  })
  return [...new Set([...MATRIX_ENVIRONMENTS, ...declared])]
}

function validateCommands(command: CommandTarget['command']): void {
  const commands = Array.isArray(command) ? command : [command]
  if (!commands.length || commands.some(command => !command.trim()))
    throw new Error('Target commands must contain non-empty commands')
}

function normalizeTarget(name: string, value: TargetConfig): NormalizedTarget {
  const target = typeof value === 'string' || Array.isArray(value) ? { command: value } : { ...value }
  if (!target.command)
    throw new Error(`Target ${name} must define a command`)
  validateCommands(target.command)
  const artifacts = target.artifacts
    ? {
        mode: target.artifacts.mode ?? MATRIX_DEFAULTS.artifacts.mode,
        format: target.artifacts.format ?? MATRIX_DEFAULTS.artifacts.format,
        clean: target.artifacts.clean ?? MATRIX_DEFAULTS.artifacts.clean,
      }
    : undefined
  const { artifacts: _configuredArtifacts, ...targetWithoutArtifacts } = target
  const targetDefaults = MATRIX_DEFAULTS.targets[name as keyof typeof MATRIX_DEFAULTS.targets]
  const continuous = target.continuous ?? targetDefaults?.continuous ?? false
  if (continuous && Array.isArray(target.command))
    throw new Error('Continuous targets cannot use multiple commands')
  return {
    ...targetWithoutArtifacts,
    name,
    continuous,
    nodeEnv: target.nodeEnv ?? targetDefaults?.nodeEnv ?? 'development',
    outputDir: target.outputDir ?? MATRIX_DEFAULTS.outputDir,
    ...(artifacts ? { artifacts } : {}),
    dependsOn: (target.dependsOn ?? []).map(dependency => typeof dependency === 'string' ? { variant: dependency } : dependency),
  }
}

function mergeTarget(base: NormalizedTarget, override: TargetOverride): NormalizedTarget {
  if (typeof override === 'string' || Array.isArray(override))
    return normalizeTarget(base.name, override)
  const readyWhen = override.readyWhen === undefined
    ? base.readyWhen
    : { ...base.readyWhen, ...override.readyWhen }
  const artifacts = override.artifacts === undefined
    ? base.artifacts
    : { ...(base.artifacts ?? MATRIX_DEFAULTS.artifacts), ...override.artifacts }
  return normalizeTarget(base.name, {
    ...base,
    ...override,
    artifacts,
    dependsOn: (override.dependsOn ?? base.dependsOn).map(dependency => typeof dependency === 'string' ? { variant: dependency } : dependency),
    ...(readyWhen ? { readyWhen } : {}),
  } as CommandTarget)
}

function mergeEnv(...maps: Array<EnvMap | undefined>): EnvMap {
  return Object.assign({}, ...maps.filter(Boolean))
}

function resolveProductEnvironments(config: MatrixConfig, envName: string): MatrixConfig {
  const products = Object.fromEntries(Object.entries(config.products).map(([key, product]) => {
    const { $env, ...base } = product
    const env = mergeEnv(product.env, $env?.[envName]?.env)
    return [key, { ...base, ...(Object.keys(env).length ? { env } : {}) }]
  }))
  return { ...config, products }
}

/** Resolves target, identity, and project defaults into execution-ready structures. */
export function normalizeMatrixConfig(raw: MatrixConfig): { config: MatrixConfig, projects: Record<string, NormalizedProject>, products: Record<string, NormalizedProduct> } {
  for (const project of Object.values(raw.projects)) {
    if (project.prepare !== undefined)
      validateCommands(project.prepare)
  }
  const projects = Object.fromEntries(Object.entries(raw.projects).map(([id, project]) => [id, {
    ...project,
    id,
    targets: Object.fromEntries(Object.entries(project.targets).map(([name, target]) => {
      return [name, normalizeTarget(name, target)]
    })),
  }])) as Record<string, NormalizedProject>

  const products = Object.fromEntries(Object.entries(raw.products).map(([key, product]) => {
    const variants = Object.fromEntries(Object.entries(product.variants).map(([id, value]) => {
      const variant = typeof value === 'string' ? { project: value } : value
      const project = projects[variant.project]
      if (!project)
        throw new Error(`Product ${key} variant ${id} references unknown project ${variant.project}`)
      const targets = Object.fromEntries(Object.entries(project.targets).map(([name, target]) => {
        const override = variant.targets?.[name]
        return [name, override === undefined ? target : mergeTarget(target, override)]
      }))
      for (const [name, target] of Object.entries(variant.targets ?? {})) {
        if (!(name in targets)) {
          if (typeof target === 'string' || Array.isArray(target))
            targets[name] = normalizeTarget(name, target)
          else if (target.command)
            targets[name] = normalizeTarget(name, target as CommandTarget)
          else throw new Error(`Variant ${key}/${id} target ${name} must define a command`)
        }
      }
      return [id, { ...variant, id, targets } satisfies NormalizedVariant]
    }))
    return [key, {
      ...product,
      id: product.id ?? key,
      name: product.name ?? key,
      slug: product.slug ?? key,
      key,
      variants,
    } satisfies NormalizedProduct]
  })) as Record<string, NormalizedProduct>
  return { config: raw, projects, products }
}

type LoadedMatrixConfig = ReturnType<typeof normalizeMatrixConfig> & {
  configFile: string | undefined
  layers: unknown[] | undefined
  cwd: string
  envName: string
  externalEnv: EnvMap
  dotenvKeys: string[]
}

/**
 * Loads and validates Matrix configuration through c12.
 *
 * The selected environment applies c12 `$env` layers and the dotenv files `.env`,
 * `.env.local`, `.env.<environment>`, and `.env.<environment>.local`.
 */
export async function loadMatrixConfig(options: { cwd?: string, envName?: string, configFile?: string, signal?: AbortSignal } = {}): Promise<LoadedMatrixConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const envName = options.envName ?? MATRIX_DEFAULTS.environment
  const loaded = await evaluateConfig({ ...options, cwd, envName })
  const config = resolveProductEnvironments(loaded.config, envName)
  return { ...normalizeMatrixConfig(config), configFile: loaded.configFile, layers: loaded.layers, cwd, envName, externalEnv: loaded.externalEnv, dotenvKeys: loaded.dotenvKeys }
}
