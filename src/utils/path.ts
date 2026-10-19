import { lstat, realpath } from 'node:fs/promises'
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

/** Canonical identity for an output that may not exist yet, including symlinked parents. */
export async function resolveFuturePath(filename: string): Promise<string> {
  let current = resolveFilesystemPath(filename)
  const suffix: string[] = []
  while (true) {
    try {
      return normalize(path.join(await realpath(current), ...suffix.reverse()))
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR')
        throw error
      const info = await lstat(current).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR')
          return undefined
        throw failure
      })
      // A dangling link has no verifiable physical owner; do not treat it as a new path.
      if (info?.isSymbolicLink())
        throw new Error(`Cannot resolve Matrix output ownership through dangling symlink ${current}`, { cause: error })
      const parent = path.dirname(current)
      if (parent === current)
        throw error
      suffix.push(path.basename(current))
      current = parent
    }
  }
}

export function containsPath(root: string, filename: string): boolean {
  const relative = path.relative(root, filename)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
