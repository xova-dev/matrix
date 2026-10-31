import type { MatrixRuntime } from '../runtime/index.js'
import type { EnvPrefix } from '../runtime/public-env.js'

/** Internal adapter ownership; never derived from Nuxt's source directory. */
export const matrixTypeRoot = Symbol('matrix-type-root')
/** Nuxt owns one public snapshot across its separate Vite pipelines. */
export const matrixSnapshot = Symbol('matrix-snapshot')
/** Nuxt's multi-prefix public contract must never silently choose an alias. */
export const matrixStrictPublicFields = Symbol('matrix-strict-public-fields')

export interface MatrixUnpluginOptions {
  [matrixTypeRoot]?: string
  [matrixSnapshot]?: (runtime: MatrixRuntime, prefixes: string[]) => MatrixRuntime
  [matrixStrictPublicFields]?: boolean
  /** Public prefixes for non-Vite adapters; Vite uses the resolved config. */
  envPrefix?: EnvPrefix
  /** Build scope used to isolate Electron main/preload/renderer runtime modules and types. */
  scope?: string
  /** Inline static reads on supported hosts. Set false for runtime-only integration. Defaults to true. */
  inline?: boolean
  /**
   * Generate declarations during prepare and Matrix builds; builds skip Vitest by default.
   * Set true/object to opt in to all builds, or false to disable both.
   */
  types?: boolean | { output?: string }
}
