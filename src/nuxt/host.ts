import type { Nuxt } from 'nuxt/schema'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'pathe'

export function assertNuxtPipeline(nuxt: Nuxt): void {
  if (nuxt.options.builder !== '@nuxt/vite-builder')
    throw new Error('Matrix Nuxt mixed integration requires the Nuxt Vite builder.')
  if (nuxt.options.experimental.viteEnvironmentApi)
    throw new Error('Matrix Nuxt mixed integration does not support experimental.viteEnvironmentApi; disable it or use native integration.')
}

/** Nuxt exposes ESM-only entries; require.resolve cannot select their import branch. */
export async function resolveNuxtHost(root: string): Promise<{ entry: string, kit: typeof import('nuxt/kit') }> {
  const require = createRequire(path.join(root, 'package.json'))
  const manifest = require.resolve('nuxt/package.json')
  type Export = string | { import: string }
  const metadata = JSON.parse(await readFile(manifest, 'utf8')) as { exports: { '.': Export, './kit': Export } }
  const resolveExport = (value: Export): string => path.resolve(path.dirname(manifest), typeof value === 'string' ? value : value.import)
  const entry = resolveExport(metadata.exports['.'])
  const kit = await import(pathToFileURL(resolveExport(metadata.exports['./kit'])).href) as typeof import('nuxt/kit')
  return { entry, kit }
}
