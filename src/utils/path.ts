import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { normalize } from 'pathe'

/** Resolve with host filesystem semantics before normalizing the representation. */
export function resolveFilesystemPath(...segments: string[]): string {
  return normalize(path.resolve(...segments))
}

/** Existing filesystem paths only; preserve errors and never apply to module IDs. */
export async function resolveExistingPath(path: string): Promise<string> {
  return normalize(await realpath(path))
}
