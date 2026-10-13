import type { EnvPrefix } from '../runtime/public-env.js'

export interface MatrixUnpluginOptions {
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
