import type { InlineConfig } from 'vite'
import type { GenerateMatrixTypesOptions } from './generate.js'
import type { TypePreparationRequest, TypePreparationResult } from './prepare.js'
import { createRequire } from 'node:module'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import path from 'pathe'

process.once('message', async (request: TypePreparationRequest) => {
  let result: TypePreparationResult
  try {
    const { resolveExistingPath } = (import.meta.url.endsWith('.ts')
      ? await import(new URL('../utils/path.ts', import.meta.url).href)
      : await import('../utils/path.js')) as typeof import('../utils/path.js')
    // Keep the packaged import statically visible so its exports survive tree shaking.
    const { setTypeCollector } = (import.meta.url.endsWith('.ts')
      ? await import(new URL('./collector.ts', import.meta.url).href)
      : await import('./collector.js')) as typeof import('./collector.js')
    const types: GenerateMatrixTypesOptions[] = []
    let plugins = 0
    setTypeCollector((options) => {
      plugins++
      if (options)
        types.push(options)
    })
    const root = await resolveExistingPath(process.cwd())
    const require = createRequire(path.join(root, 'package.json'))
    const hostEntry = require.resolve(request.host.name)
    const viteEntry = request.host.name === 'vite' ? hostEntry : createRequire(hostEntry).resolve('vite')
    const vite = await import(pathToFileURL(viteEntry).href) as typeof import('vite')
    const inline = { configFile: request.host.configFile, mode: request.mode, logLevel: 'silent' as const }
    if (request.host.name === 'vite') {
      await vite.resolveConfig(inline, 'serve', 'development', 'development')
    }
    else {
      const electron = await import(pathToFileURL(hostEntry).href) as {
        resolveConfig: (config: InlineConfig, command: 'serve', mode: string) => Promise<{ config?: { main?: InlineConfig, preload?: InlineConfig, renderer?: InlineConfig } }>
      }
      process.env.NODE_ENV_ELECTRON_VITE = 'development'
      const resolved = await electron.resolveConfig({ ...inline, root }, 'serve', 'development')
      // Electron's dev lifecycle builds main/preload but serves renderer. Only resolve those configs here.
      for (const context of ['main', 'preload', 'renderer'] as const) {
        const config = resolved.config?.[context]
        if (config)
          await vite.resolveConfig(config, context === 'renderer' ? 'serve' : 'build', 'development', 'development')
      }
    }
    // Send field names and schema only, never configuration values.
    // null means no plugin; an empty array preserves explicit types:false.
    result = {
      types: plugins
        ? await Promise.all(types.map(async options => ({
            ...options,
            cwd: await resolveExistingPath(options.cwd),
            env: Object.fromEntries(Object.keys(options.env).map(key => [key, ''])),
          })))
        : null,
    }
  }
  catch (error) {
    result = { error: error instanceof Error ? error.message : 'Host configuration failed' }
  }
  process.send?.(result)
})
