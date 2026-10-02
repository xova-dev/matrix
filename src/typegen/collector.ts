import type { GenerateMatrixTypesOptions } from './generate.js'

// Shared across package copies loaded by the host config, only inside the preparation process.
const key = Symbol.for('@xova/matrix/type-preparation')
type Collector = (options: GenerateMatrixTypesOptions | undefined) => void
const context = globalThis as typeof globalThis & { [key]?: Collector }

export function setTypeCollector(collector: Collector): void {
  context[key] = collector
}

export function collectPreparedTypes(options: GenerateMatrixTypesOptions | undefined): boolean {
  if (!context[key])
    return false
  context[key](options)
  return true
}
