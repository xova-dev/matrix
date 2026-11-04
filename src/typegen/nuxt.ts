import type { LoadConfigOptions } from 'c12'
import type { Nuxt } from 'nuxt/schema'
import type { InlineConfig } from 'vite'
import type { WorkerChannel } from '../execution/channel.js'
import type { TypePreparationRequest } from './prepare.js'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** Stop after Nuxt's complete client-config dispatch, before a server/build starts. */
export async function resolveNuxtTypes(root: string, request: TypePreparationRequest, channel: WorkerChannel): Promise<void> {
  const { assertNuxtPipeline, resolveNuxtHost } = (import.meta.url.endsWith('.ts')
    ? await import(new URL('../nuxt/host.ts', import.meta.url).href)
    : await import('../nuxt/host.js')) as typeof import('../nuxt/host.js')
  const { entry, kit } = await resolveNuxtHost(root)
  const asURL = (value: string): URL => value.startsWith('file:') ? new URL(value) : pathToFileURL(value)
  const builder = kit.resolveModule('@nuxt/vite-builder', { url: pathToFileURL(entry) })
  const { resolveConfig } = await import(asURL(kit.resolveModule('vite', { url: asURL(builder) })).href) as typeof import('vite')
  let nativeLoader: typeof import('c12') | undefined
  if (request.host.explicit) {
    const kitManifest = kit.resolveModule('@nuxt/kit/package.json', { url: pathToFileURL(entry) })
    const metadata = JSON.parse(await readFile(kitManifest, 'utf8')) as { dependencies?: Record<string, string> }
    if (metadata.dependencies?.c12)
      nativeLoader = await import(pathToFileURL(createRequire(kitManifest).resolve('c12')).href) as typeof import('c12')
  }
  // configFile applies to every Layer, not just the app. Keep Nuxt's native
  // basename and intercept only the root when an exact file was selected.
  const nuxt = await kit.loadNuxt({
    cwd: root,
    dev: request.command !== 'build',
    ready: false,
    ...(request.host.explicit && {
      async resolve(source, context) {
        if (source !== '.' || context.cwd !== root)
          return
        if (nativeLoader) {
          const options: LoadConfigOptions = { ...context as LoadConfigOptions, cwd: root, configFile: request.host.configFile, extend: false, rcFile: false, globalRc: false, dotenv: false, configFileRequired: true }
          delete options.resolve
          delete options.overrides
          delete options.defaults
          delete options.defaultConfig
          const selected = await nativeLoader.loadConfig(options)
          return { config: selected.config, cwd: root, configFile: selected.configFile!, ...(selected.meta && { meta: selected.meta }) }
        }
        // New Kit bundles c12. Its public raw snapshot preserves that exact
        // loader's env/function semantics without leaking schema defaults.
        let selected: Parameters<NonNullable<Parameters<typeof kit.loadNuxtConfig>[0]['onConfigResolved']>>[0] | undefined
        await kit.loadNuxtConfig({
          cwd: root,
          configFile: request.host.configFile,
          rcFile: false,
          globalRc: false,
          dotenv: false,
          ...(context.import && { import: context.import }),
          resolve: source => source === '.' ? undefined : { config: {} },
          onConfigResolved: (result) => { selected = result },
        })
        if (!selected?.configFile)
          throw new Error('Nuxt Kit did not provide the selected root configuration')
        const configFile = selected.configFile
        const meta = selected.layers.find(layer => layer.configFile === configFile)?.meta
        return { config: selected.rawConfig, cwd: root, configFile, ...(meta && { meta }) }
      },
    }),
  })
  const stop = new Error('Matrix client configuration collected')
  const callHook = nuxt.callHook
  let collected = false
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= nuxt.close()
  const terminate = (): void => {
    void close().finally(() => process.exit(143))
  }
  const cancel = (message: unknown): void => {
    if (message === 'cancel')
      void close().then(() => channel.send('cancelled'), () => channel.send('cancelled'))
  }
  process.once('SIGTERM', terminate)
  channel.on('message', cancel)
  let failure: unknown
  try {
    await nuxt.ready()
    assertNuxtPipeline(nuxt)
    // A normal hook cannot stop after hooks registered later or hook interceptors.
    // This isolated worker awaits the original full dispatch and always restores it.
    nuxt.callHook = (async (name: string, ...args: unknown[]) => {
      await (callHook as (...args: unknown[]) => Promise<void>).call(nuxt, name, ...args)
      if (name === 'vite:configResolved' && (args[1] as { isClient?: boolean })?.isClient) {
        const config = args[0] as InlineConfig
        await resolveConfig({ ...config, configFile: false }, request.command ?? 'serve', request.nodeEnv, request.nodeEnv)
        collected = true
        throw stop
      }
    }) as Nuxt['callHook']
    await kit.buildNuxt(nuxt)
    if (!collected)
      throw new Error('Nuxt did not provide its client Vite configuration')
  }
  catch (error) {
    if (error !== stop)
      failure = error
  }
  finally {
    nuxt.callHook = callHook
    try {
      await close()
    }
    catch (error) {
      failure = failure
        ? new Error(`${failure instanceof Error ? failure.message : String(failure)}; Nuxt close failed: ${error instanceof Error ? error.message : String(error)}`, { cause: new AggregateError([failure, error], 'Nuxt preparation and cleanup failed') })
        : error
    }
    process.removeListener('SIGTERM', terminate)
    channel.removeListener('message', cancel)
  }
  if (failure)
    throw failure
}
