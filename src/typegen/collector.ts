import type { GenerateMatrixTypesOptions } from './generate.js'

// Shared across package copies loaded by the host config, only inside the preparation process.
const key = Symbol.for('@xova/matrix/type-preparation')
type Collector = (options: GenerateMatrixTypesOptions | undefined) => void
const context = globalThis as typeof globalThis & { [key]?: { collect: Collector, automatic: boolean } }

export function setTypeCollector(collector: Collector, automatic = false): void {
  context[key] = { collect: collector, automatic }
}

export function collectPreparedTypes(options: GenerateMatrixTypesOptions | undefined): boolean {
  if (!context[key])
    return false
  context[key].collect(options)
  return true
}

export function isAutomaticTypeCollection(): boolean {
  return context[key]?.automatic ?? false
}
