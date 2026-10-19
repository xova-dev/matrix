import type { GenerateMatrixTypesOptions } from './generate.js'
import { serializeEnvSchema } from '../config/env-schema.js'
import { ensureMatrixEnvPrefix, publicEnvKeys } from '../runtime/public-env.js'
import { matrixTypeOutput } from './generate.js'

/** Private, value-free handshake between the CLI coordinator and host plugins. */
export { MATRIX_TYPE_CONTRACT_KEY } from '../config/env-schema.js'

export interface PreparedTypeContract {
  strict: boolean
  declarations: Array<{ output: string, signature: string, keys: string[] }>
}

function signature(options: GenerateMatrixTypesOptions): string {
  const schema = JSON.parse(serializeEnvSchema(options.envSchema)) as Record<string, unknown>
  return JSON.stringify([
    options.scope ?? '',
    ensureMatrixEnvPrefix(options.envPrefix),
    Object.entries(schema).sort(([a], [b]) => a.localeCompare(b)),
  ])
}

export function preparedTypeDeclaration(options: GenerateMatrixTypesOptions): PreparedTypeContract['declarations'][number] {
  return {
    output: matrixTypeOutput(options),
    signature: signature(options),
    keys: publicEnvKeys(options.env, ensureMatrixEnvPrefix(options.envPrefix)),
  }
}

/** A plugin may consume the complete contract, but must never silently widen or replace it. */
export function hasPreparedTypeContract(value: string | undefined, options: GenerateMatrixTypesOptions): boolean {
  if (value === undefined)
    return false
  let contract: PreparedTypeContract
  try {
    contract = JSON.parse(value) as PreparedTypeContract
    if (typeof contract?.strict !== 'boolean' || !Array.isArray(contract.declarations)
      || contract.declarations.some(declaration => !declaration || typeof declaration.output !== 'string'
        || typeof declaration.signature !== 'string' || !Array.isArray(declaration.keys)
        || declaration.keys.some(key => typeof key !== 'string'))) {
      throw new Error('Invalid contract')
    }
  }
  catch {
    throw new Error('Invalid Matrix internal type contract')
  }
  // Generic preparation cannot resolve a non-Vite host's plugin options.
  if (!contract.strict)
    return false
  const active = preparedTypeDeclaration(options)
  const prepared = contract.declarations.find(declaration => declaration.output === active.output)
  if (!prepared || prepared.signature !== active.signature || active.keys.some(key => !prepared.keys.includes(key)))
    throw new Error(`Matrix type contract changed after collection for ${active.output}. Keep scope, prefixes, output, and public fields stable across host resolutions, then rerun Matrix.`)
  return true
}
