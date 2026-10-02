import type { LoaderContext } from 'webpack'
import type { MatrixRuntime } from './runtime.js'

interface Options {
  runtimeId: string
  runtime: MatrixRuntime
}

type InputMap = Parameters<LoaderContext<Options>['callback']>[2]
type AdditionalData = Parameters<LoaderContext<Options>['callback']>[3]

export default async function transform(this: LoaderContext<Options>, code: string, inputMap: InputMap, meta: AdditionalData): Promise<void> {
  const callback = this.async()
  try {
    // Match the source/packaged worker convention, keeping the packaged import
    // visible to the build so the shared transform survives tree shaking.
    const { inlineMatrixReads } = (import.meta.url.endsWith('.ts')
      ? await import(new URL('./runtime-transform.ts', import.meta.url).href)
      : await import('./runtime-transform.js')) as typeof import('./runtime-transform.js')
    const { runtimeId, runtime } = this.getOptions()
    const result = inlineMatrixReads(code, this.resourcePath, runtimeId, runtime)
    if (!result) {
      callback(null, code, inputMap, meta)
      return
    }
    const map = JSON.parse(result.map.toString())
    // Always forward a new map, even without an upstream map. Compose existing
    // maps with Webpack's own implementation instead of adding a dependency.
    const combined = inputMap
      ? new this._compiler!.webpack.sources.SourceMapSource(result.code, this.resourcePath, map, code, inputMap, true).map()
      : map
    // Upstream AST metadata describes the old source and must not be reused.
    callback(null, result.code, combined)
  }
  catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)))
  }
}
