import { realpath } from 'node:fs/promises'
import { normalize } from 'pathe'

/** Existing filesystem paths only; preserve errors and never apply to module IDs. */
export async function resolveExistingPath(path: string): Promise<string> {
  return normalize(await realpath(path))
}
