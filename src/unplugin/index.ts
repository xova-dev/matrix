import type { UnpluginFactory } from 'unplugin'
import type { MatrixRuntime } from '../runtime/index.js'
import type { GenerateMatrixTypesOptions } from '../typegen/generate.js'
import type { MatrixUnpluginOptions } from './options.js'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'pathe'
import { createUnplugin } from 'unplugin'
import { MATRIX_ENV_SCHEMA_KEY, readEnvSchema } from '../config/env-schema.js'
import { ensureMatrixEnvPrefix } from '../runtime/public-env.js'
import { createMatrixRuntime, runtimeModule } from '../runtime/snapshot.js'
import { inlineMatrixReads } from '../runtime/transform.js'
import { collectPreparedTypes } from '../typegen/collector.js'
import { generateMatrixTypes, matrixRuntimeModuleId } from '../typegen/generate.js'
import { currentProcessEnv } from '../utils/env.js'
import { setupMatrixEsbuildTransform } from './esbuild-transform.js'
import { isVueScriptRequest } from './vue.js'

export const MATRIX_RUNTIME_ID = 'virtual:matrix/runtime'

export type { MatrixRuntime } from '../runtime/index.js'
export type { EnvPrefix } from '../runtime/public-env.js'

export { ensureMatrixEnvPrefix, normalizeEnvPrefix } from '../runtime/public-env.js'

function isVitest(): boolean {
  return process.env.VITEST !== undefined
}

function isScriptFile(id: string): boolean {
  return path.isAbsolute(id) && !/[\0?#]/.test(id) && /\.[cm]?[jt]sx?$/.test(id)
}

/** Shared Unplugin factory; host adapters are exported from separate entrypoints. */
export const matrixUnpluginFactory: UnpluginFactory<MatrixUnpluginOptions | undefined, false> = (options = {}, meta) => {
  let envPrefix = ensureMatrixEnvPrefix(options.envPrefix)
  let env = currentProcessEnv()
  const envSchema = readEnvSchema(env)
  let typesGenerated = false
  const runtimeId = matrixRuntimeModuleId(options.scope)
  const requestId = meta.framework === 'webpack' ? runtimeId.replace('virtual:', '__matrix_virtual__/') : runtimeId
  const resolvedRuntimeId = `\0${runtimeId}`
  let runtime: MatrixRuntime | undefined
  let vueScriptsEnabled = false

  function snapshot(): MatrixRuntime {
    return runtime ??= createMatrixRuntime(env, envPrefix, envSchema)
  }

  function typeOptions(cwd: string): GenerateMatrixTypesOptions {
    return {
      cwd,
      env,
      envPrefix,
      envSchema,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(typeof options.types === 'object' && options.types.output ? { output: options.types.output } : {}),
    }
  }

  async function generateTypes(cwd: string): Promise<void> {
    if (options.types === false || (options.types === undefined && isVitest()) || typesGenerated)
      return
    await generateMatrixTypes(typeOptions(cwd))
    typesGenerated = true
  }

  return {
    name: 'xova-matrix',
    enforce: 'post',
    esbuild: {
      // The generic loader owns only this scope's virtual module. Unplugin's
      // transform adapter reads paths before testing its code filter.
      onLoadFilter: new RegExp(`^\\x00${runtimeId}$`),
      setup(build) {
        if (options.inline !== false)
          setupMatrixEsbuildTransform(build, runtimeId, snapshot)
      },
    },
    webpack(compiler) {
      if (options.inline !== false) {
        const loader = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './webpack-loader.ts' : '../webpack-loader.js', import.meta.url))
        compiler.options.module.rules.unshift({
          enforce: 'post',
          resource: isScriptFile,
          resourceQuery: query => !query,
          resourceFragment: fragment => !fragment,
          use: [{ loader, options: { runtimeId, runtime: snapshot() } }],
        })
        compiler.hooks.compilation.tap('xova-matrix', (compilation) => {
          compiler.webpack.NormalModule.getCompilationHooks(compilation).loader.tap('xova-matrix', (_context, module) => {
            // Remove our loader before loader-runner can decode an asset Buffer.
            if (!module.type.startsWith('javascript/'))
              module.loaders = module.loaders.filter(item => item.loader !== loader)
          })
        })
      }
      // URI schemes bypass Webpack's resolver (and Unplugin's resolveId).
      // Redirect only our exact public module to a normal resolver request.
      compiler.hooks.normalModuleFactory.tap('xova-matrix', (factory) => {
        factory.hooks.beforeResolve.tap('xova-matrix', (data) => {
          if (data?.request === runtimeId)
            data.request = requestId
        })
      })
    },
    vite: {
      config(config) {
        const configuredPrefix = options.envPrefix ?? config.envPrefix
        return {
          envPrefix: ensureMatrixEnvPrefix(configuredPrefix),
          // Vite snapshots env before configResolved; mask both direct reads and its env object.
          define: { [`import.meta.env.${MATRIX_ENV_SCHEMA_KEY}`]: 'undefined' },
        }
      },
      async configResolved(config) {
        // Vue remains optional. Its official plugin compiles SFCs before our
        // post transform; never parse or compile SFC source ourselves.
        vueScriptsEnabled = config.plugins.some(plugin => plugin.name === 'vite:vue' && typeof plugin.api?.version === 'string')
        // Even a custom broad prefix must not make internal metadata public.
        delete config.env[MATRIX_ENV_SCHEMA_KEY]
        envPrefix = ensureMatrixEnvPrefix(config.envPrefix)
        env = { ...config.env }
        // Preparation needs the schema, not credentials or values for a runnable build.
        if (collectPreparedTypes(options.types === false ? undefined : typeOptions(config.root)))
          return
        runtime = createMatrixRuntime(env, envPrefix, envSchema)
        await generateTypes(config.root)
      },
    },
    async buildStart() {
      snapshot()
      await generateTypes(process.cwd())
    },
    resolveId(id) {
      return id === requestId ? resolvedRuntimeId : undefined
    },
    // Some adapters attach module-type rules before calling load. Returning
    // undefined inside load alone does not protect unrelated resources.
    loadInclude(id) {
      return id === resolvedRuntimeId
    },
    load(id) {
      if (id !== resolvedRuntimeId)
        return undefined
      return runtimeModule(snapshot())
    },
    transformInclude(id) {
      return isScriptFile(id) || (vueScriptsEnabled && isVueScriptRequest(id))
    },
    // Esbuild and Webpack have ownership-aware adapters above. Unverified adapters
    // keep the virtual runtime without installing an eager transform pipeline.
    transform: options.inline === false || !['vite', 'rollup'].includes(meta.framework)
      ? undefined
      : meta.framework === 'rollup'
        // Rollup 2 supports function hooks before it supports object hooks.
        ? (code, id) => code.includes(runtimeId) ? inlineMatrixReads(code, id, runtimeId, snapshot()) : undefined
        : {
            filter: { code: runtimeId },
            handler(code, id) {
              return inlineMatrixReads(code, id, runtimeId, snapshot())
            },
          },
  }
}

export const MatrixUnplugin = createUnplugin<MatrixUnpluginOptions | undefined, false>(matrixUnpluginFactory)
export type { MatrixUnpluginOptions } from './options.js'
