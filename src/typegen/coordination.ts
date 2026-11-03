import type { GenerateMatrixTypesOptions } from './generate.js'
import { serializeEnvSchema } from '../config/env-schema.js'
import { ensureMatrixEnvPrefix, resolvePublicEnvFields } from '../runtime/public-env.js'
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
    !!options.strictPublicFields,
  ])
}

export function preparedTypeDeclaration(options: GenerateMatrixTypesOptions): PreparedTypeContract['declarations'][number] {
  return {
    output: matrixTypeOutput(options),
    signature: signature(options),
    keys: resolvePublicEnvFields(options.env, ensureMatrixEnvPrefix(options.envPrefix), options.envSchema, options.strictPublicFields).keys,
  }
}

/** Hosts may add inputs without widening the prepared Matrix public surface. */
export function resolvePreparedTypeDeclaration(value: string | undefined, options: GenerateMatrixTypesOptions): PreparedTypeContract['declarations'][number] | undefined {
  if (value === undefined)
    return undefined
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
    return undefined
  const output = matrixTypeOutput(options)
  const prepared = contract.declarations.find(declaration => declaration.output === output)
  if (!prepared || prepared.signature !== signature(options))
    throw new Error(`Matrix type contract changed after collection for ${output}. Keep scope, prefixes, output, and public fields stable across host resolutions, then rerun Matrix.`)
  return prepared
}
