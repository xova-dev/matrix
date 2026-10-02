import type { SourceMapInput } from '@jridgewell/remapping'
import type { Loader, PluginBuild } from 'esbuild'
import type { Comment } from 'oxc-parser'
import type { MatrixRuntime } from './runtime.js'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import remapping from '@jridgewell/remapping'
import { inlineMatrixReads } from './runtime-transform.js'

// Undefined means no map; null means the owning loader must handle this map.
function inlineSourceMap(comments: readonly Comment[]): SourceMapInput | null | undefined {
  // Reuse the transform's parsed comments; strings are not map directives.
  let directive: string | undefined
  for (const comment of comments) {
    if (!/[@#]\s*sourceMappingURL\s*=/.test(comment.value))
      continue
    // Esbuild recognizes an exact marker followed by a URL token (and allows
    // trailing text). Ambiguous spellings must retain the host's interpretation.
    const match = /^[@#] sourceMappingURL=(\S+)/.exec(comment.value)
    if (!match)
      return null
    directive = match[1]
  }
  if (!directive)
    return
  const inline = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(directive)
  if (!inline)
    return null
  try {
    const map = JSON.parse(inline[1] ? Buffer.from(inline[2]!, 'base64').toString('utf8') : decodeURIComponent(inline[2]!))
    return map && typeof map === 'object' ? map as SourceMapInput : null
  }
  catch {
    return null
  }
}

/** Esbuild has first-owner loaders, not a chain of source transforms. */
export function setupMatrixEsbuildTransform(build: PluginBuild, runtimeId: string, snapshot: () => MatrixRuntime): void {
  const defaults: Record<string, Loader> = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx' }
  build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: 'file' }, async (args) => {
    // Foreign namespaces, resource queries and attributes retain their owners.
    if (args.suffix || Object.keys(args.with).length)
      return
    const extension = path.extname(args.path)
    const loader = build.initialOptions.loader?.[extension] ?? defaults[extension]
    if (loader !== 'js' && loader !== 'jsx' && loader !== 'ts' && loader !== 'tsx')
      return
    let code: string
    try {
      code = await readFile(args.path, 'utf8')
    }
    catch {
      // A later plugin may synthesize a file that does not exist on disk.
      return
    }
    const result = inlineMatrixReads(code, args.path, runtimeId, snapshot(), loader)
    if (!result)
      return
    const upstream = inlineSourceMap(result.comments)
    if (upstream === null)
      return
    let map = result.map.toString()
    if (upstream) {
      try {
        // The loader form resolves relative upstream sources/sourceRoot against
        // this input file, not against the eventual bundle's output directory.
        map = remapping(map, (_source, context) => context.depth === 1 ? upstream : null).toString()
      }
      catch {
        // Invalid maps must not silently become plausible but incorrect maps.
        return
      }
    }
    return {
      contents: `${result.code}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(map).toString('base64')}`,
      loader,
      pluginData: args.pluginData,
      resolveDir: path.dirname(args.path),
      watchFiles: [args.path],
    }
  })
}
