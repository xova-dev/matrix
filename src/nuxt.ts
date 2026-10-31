import type { Nuxt, NuxtModule } from 'nuxt/schema'
import type { InlineConfig, Plugin } from 'vite'
import type { MatrixRuntime } from './runtime/index.js'
import type { MatrixUnpluginOptions } from './unplugin/options.js'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import { MATRIX_ENV_SCHEMA_KEY, MATRIX_TYPE_CONTRACT_KEY } from './config/env-schema.js'
import { assertNuxtPipeline, resolveNuxtHost } from './nuxt/host.js'
import { runtimeModule } from './runtime/snapshot.js'
import { isCollectingTypes } from './typegen/collector.js'
import { matrixRuntimeModuleId, matrixTypeOutput } from './typegen/generate.js'
import { matrixSnapshot, matrixStrictPublicFields, matrixTypeRoot } from './unplugin/options.js'
import matrix from './unplugin/vite.js'

export type MatrixNuxtOptions = Omit<MatrixUnpluginOptions, typeof matrixTypeRoot | typeof matrixSnapshot | typeof matrixStrictPublicFields>

declare module 'nuxt/schema' {
  interface NuxtConfig {
    matrix?: MatrixNuxtOptions
  }
  interface NuxtOptions {
    matrix?: MatrixNuxtOptions
  }
}

const meta = { name: '@xova/matrix/nuxt', configKey: 'matrix' }

async function setup(options: MatrixNuxtOptions, nuxt: Nuxt): Promise<void> {
  assertNuxtPipeline(nuxt)
  const root = nuxt.options.rootDir
  const adapterOptions: MatrixUnpluginOptions = {
    ...options,
    envPrefix: options.envPrefix ?? ['VITE_', 'NUXT_PUBLIC_'],
    [matrixTypeRoot]: root,
    [matrixStrictPublicFields]: true,
  }
  let snapshot: MatrixRuntime | undefined
  let prefixes: string[] | undefined
  let nitroPreset: string | undefined
  const sharedSnapshot = (runtime: MatrixRuntime, resolvedPrefixes: string[]): MatrixRuntime => {
    if (snapshot && (!isDeepStrictEqual(prefixes, resolvedPrefixes) || !isDeepStrictEqual(snapshot, runtime)))
      throw new Error('Matrix Nuxt client/server public snapshots differ. Keep public envPrefix and public configuration identical in both Vite pipelines; use native runtimeConfig for server-only or deployment configuration.')
    prefixes ??= resolvedPrefixes
    return snapshot ??= runtime
  }
  nuxt.hook('nitro:init', (nitro) => {
    nitroPreset = (nitro as { options: { preset?: string } }).options.preset
  })
  if (options.types !== false) {
    const output = matrixTypeOutput({ cwd: root, ...options, ...(typeof options.types === 'object' && options.types.output ? { output: options.types.output } : {}) })
    nuxt.hook('prepare:types', ({ references }) => {
      references.push({ path: output })
    })
  }
  nuxt.hook('vite:extendConfig', (config) => {
    const guard: Plugin = {
      name: 'xova-matrix:nuxt',
      configResolved(resolved) {
        if (resolved.plugins.filter(plugin => plugin.name === 'xova-matrix').length !== 1)
          throw new Error('Install Matrix only through @xova/matrix/nuxt in Nuxt; remove the manual Matrix Vite plugin.')
        // Nuxt prepare/typecheck needs only a declaration reference, not a runtime.
        // Actual Vite starts must receive Matrix's product environment.
        if (isCollectingTypes())
          return
        if (!Object.hasOwn(process.env, MATRIX_ENV_SCHEMA_KEY))
          throw new Error('Matrix Nuxt runtime has no product context. Start dev/build through the Matrix CLI; use native runtimeConfig without this module for standalone Nuxt.')
        if (options.types !== false && process.env[MATRIX_TYPE_CONTRACT_KEY] === undefined)
          throw new Error('Matrix Nuxt has no prepared type contract. Use Matrix dev/build with project.typegen enabled; with project.typegen:false, also set the Nuxt module option types:false for runtime-only mixed integration.')
      },
    }
    const vite = config as InlineConfig
    vite.plugins ??= []
    vite.plugins.push(guard, ...[matrix({ ...adapterOptions, [matrixSnapshot]: sharedSnapshot })].flat())
  })
  nuxt.hook('nitro:config', (nitroConfig) => {
    // Nuxt's public types fall back to unknown when optional Nitro types are absent.
    const config = nitroConfig as { rollupConfig?: { plugins?: Plugin[] } }
    const id = matrixRuntimeModuleId(options.scope)
    config.rollupConfig ??= {}
    config.rollupConfig.plugins ??= []
    config.rollupConfig.plugins.push({
      name: 'xova-matrix:nuxt-nitro',
      resolveId(source) {
        if (source !== id)
          return
        if (!nitroPreset || !['node-server', 'nitro-dev'].includes(nitroPreset))
          throw new Error('Matrix direct Nitro imports support only the node-server preset. Use native runtimeConfig with other Nitro presets.')
        return `\0${id}`
      },
      load(source) {
        if (source !== `\0${id}`)
          return
        if (!snapshot)
          throw new Error('Matrix Nitro has no public build snapshot. Start dev/build through the Matrix CLI and keep the Nuxt Vite pipeline enabled.')
        return runtimeModule(snapshot)
      },
    })
  })
}

/** Resolve Nuxt Kit from the consuming Nuxt, not Matrix's installation. */
const module: NuxtModule<MatrixNuxtOptions> = Object.assign(async (options: MatrixNuxtOptions, nuxt: Nuxt) => {
  const { kit } = await resolveNuxtHost(nuxt.options.rootDir)
  return kit.defineNuxtModule<MatrixNuxtOptions>({ meta, setup })(options, nuxt)
}, { getMeta: async () => meta })

export default module
