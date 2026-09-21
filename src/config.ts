import type { CommandTarget, EnvMap, MatrixConfig, NormalizedProduct, NormalizedProject, NormalizedTarget, NormalizedVariant, TargetConfig, TargetOverride } from './types.js'
import path from 'node:path'
import process from 'node:process'
import { loadConfig } from 'c12'
import { MATRIX_DEFAULTS } from './defaults.js'
import { assertMatrixConfig } from './schema.js'
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

interface RawEnvironmentConfig {
  $env?: Record<string, unknown>
  products?: Record<string, { $env?: Record<string, unknown> }>
}

/**
 * Lists built-in and configured environment names without applying dotenv or process overrides.
 *
 * When `productName` is provided, product-scoped environments are included only for that
 * product. This is used by the interactive CLI after product selection.
 */
export async function listMatrixEnvironments(options: { cwd?: string, configFile?: string, productName?: string } = {}): Promise<string[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const loaded = await loadConfig<RawEnvironmentConfig>({
    name: 'matrix',
    cwd,
    ...(options.configFile ? { configFile: options.configFile } : {}),
    envName: false,
    dotenv: false,
    omit$Keys: false,
    rcFile: false,
    packageJson: false,
  })
  const config = loaded.config
  const environments = new Set<string>(MATRIX_ENVIRONMENTS)
  for (const name of Object.keys(config.$env ?? {}))
    environments.add(name)
  const selectedProduct = options.productName ? config.products?.[options.productName] : undefined
  const products = options.productName
    ? (selectedProduct ? [selectedProduct] : [])
    : Object.values(config.products ?? {})
  for (const product of products) {
    for (const name of Object.keys(product.$env ?? {}))
      environments.add(name)
  }
  return [...environments]
}

function normalizeTarget(name: string, value: TargetConfig): NormalizedTarget {
  const target = typeof value === 'string' || Array.isArray(value) ? { command: value } : { ...value }
  if (!target.command)
    throw new Error(`Target ${name} must define a command`)
  if (Array.isArray(target.command) && (!target.command.length || target.command.some(command => !command.trim())))
    throw new Error('Target commands must contain non-empty commands')
  const artifacts = target.artifacts
    ? {
        mode: target.artifacts.mode ?? MATRIX_DEFAULTS.artifacts.mode,
        format: target.artifacts.format ?? MATRIX_DEFAULTS.artifacts.format,
        clean: target.artifacts.clean ?? MATRIX_DEFAULTS.artifacts.clean,
      }
    : { mode: 'none' as const, format: MATRIX_DEFAULTS.artifacts.format, clean: false }
  const targetDefaults = MATRIX_DEFAULTS.targets[name as keyof typeof MATRIX_DEFAULTS.targets]
  const continuous = target.continuous ?? targetDefaults?.continuous ?? false
  if (continuous && Array.isArray(target.command))
    throw new Error('Continuous targets cannot use multiple commands')
  return {
    ...target,
    name,
    continuous,
    nodeEnv: target.nodeEnv ?? targetDefaults?.nodeEnv ?? 'development',
    outputDir: target.outputDir ?? MATRIX_DEFAULTS.outputDir,
    artifacts,
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
    : { ...(base.artifacts.mode === 'none' ? MATRIX_DEFAULTS.artifacts : base.artifacts), ...override.artifacts }
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
}

/**
 * Loads and validates Matrix configuration through c12.
 *
 * The selected environment applies c12 `$env` layers and the dotenv files `.env`,
 * `.env.local`, `.env.<environment>`, and `.env.<environment>.local`.
 */
export async function loadMatrixConfig(options: { cwd?: string, envName?: string, configFile?: string } = {}): Promise<LoadedMatrixConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const envName = options.envName ?? MATRIX_DEFAULTS.environment
  const loadOptions = {
    name: 'matrix',
    cwd,
    ...(options.configFile ? { configFile: options.configFile } : {}),
    envName,
    dotenv: { fileName: ['.env', '.env.local', `.env.${envName}`, `.env.${envName}.local`] },
    omit$Keys: true,
    rcFile: false as const,
    packageJson: false,
  }
  const loaded = await loadConfig<MatrixConfig>(loadOptions)
  const config = resolveProductEnvironments(assertMatrixConfig(loaded.config) as MatrixConfig, envName)
  const externalEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) as EnvMap
  return { ...normalizeMatrixConfig(config), configFile: loaded.configFile, layers: loaded.layers, cwd, envName, externalEnv }
}
