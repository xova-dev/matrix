import type { UnpluginFactory } from 'unplugin'
import type { EnvPrefix } from './env.js'
import type { MatrixRuntime } from './runtime.js'
import process from 'node:process'
import { createUnplugin } from 'unplugin'
import { createPublicConfig, ensureMatrixEnvPrefix, normalizeEnvPrefix } from './env.js'
import { generateMatrixTypes, matrixRuntimeModuleId } from './typegen.js'

export const MATRIX_RUNTIME_ID = 'virtual:matrix/runtime'

export type { EnvPrefix } from './env.js'
export { ensureMatrixEnvPrefix, normalizeEnvPrefix } from './env.js'

export interface MatrixUnpluginOptions {
  /** Public prefixes for non-Vite adapters; Vite uses the resolved config. */
  envPrefix?: EnvPrefix
  /** Build scope used to isolate Electron main/preload/renderer runtime modules and types. */
  scope?: string
  /** Generate project-local declarations during the build. Defaults to true. */
  types?: boolean | { output?: string }
}

export function createMatrixRuntime(env: Record<string, string>, envPrefix: EnvPrefix | undefined = ['VITE_', 'MATRIX_']): MatrixRuntime {
  const prefixes = normalizeEnvPrefix(envPrefix)
  const nodeEnv = env.NODE_ENV ?? ''
  const isProduction = nodeEnv === 'production'
  return {
    environment: env.MATRIX_ENV_NAME ?? '',
    target: env.MATRIX_TARGET ?? '',
    nodeEnv,
    isDevelopment: !isProduction,
    isProduction,
    isTest: nodeEnv === 'test',
    variant: env.MATRIX_VARIANT ?? '',
    project: env.MATRIX_PROJECT ?? '',
    product: {
      key: env.MATRIX_PRODUCT_KEY ?? '',
      id: env.MATRIX_PRODUCT_ID ?? '',
      name: env.MATRIX_PRODUCT_NAME ?? '',
      slug: env.MATRIX_PRODUCT_SLUG ?? '',
      ...(env.MATRIX_PRODUCT_APP_ID ? { appId: env.MATRIX_PRODUCT_APP_ID } : {}),
    },
    config: createPublicConfig(env, prefixes),
  }
}

function runtimeModule(runtime: MatrixRuntime): string {
  return ['export const matrix = ', JSON.stringify(runtime), '\n'].join('')
}

function currentProcessEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

/** Shared Unplugin factory; host adapters are exported from separate entrypoints. */
export const matrixUnpluginFactory: UnpluginFactory<MatrixUnpluginOptions | undefined> = (options = {}) => {
  let envPrefix = ensureMatrixEnvPrefix(options.envPrefix)
  let env = currentProcessEnv()
  let typesGenerated = false
  const runtimeId = matrixRuntimeModuleId(options.scope)
  const resolvedRuntimeId = `\0${runtimeId}`

  async function generateTypes(cwd: string): Promise<void> {
    if (options.types === false || typesGenerated)
      return
    await generateMatrixTypes({
      cwd,
      env,
      envPrefix,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(typeof options.types === 'object' && options.types.output ? { output: options.types.output } : {}),
    })
    typesGenerated = true
  }

  return {
    name: 'xova-matrix',
    vite: {
      config(config) {
        const configuredPrefix = options.envPrefix ?? config.envPrefix
        return { envPrefix: ensureMatrixEnvPrefix(configuredPrefix) }
      },
      async configResolved(config) {
        envPrefix = ensureMatrixEnvPrefix(config.envPrefix)
        env = config.env
        await generateTypes(config.root)
      },
    },
    async buildStart() {
      await generateTypes(process.cwd())
    },
    resolveId(id) {
      return id === runtimeId ? resolvedRuntimeId : undefined
    },
    load(id) {
      if (id !== resolvedRuntimeId)
        return undefined
      return runtimeModule(createMatrixRuntime(env, envPrefix))
    },
  }
}

export const MatrixUnplugin = createUnplugin(matrixUnpluginFactory)
export type { MatrixRuntime } from './runtime.js'
