import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import path from 'pathe'
import { resolveExistingPath } from '../utils/path.js'

/** Remove only a uniquely identified owner, never a successor's lock directory. */
async function releaseOwner(lock: string, owner: string): Promise<boolean> {
  // File deletion/rename completion does not elect one winner on every OS.
  // Keep a per-owner mkdir claim until the whole directory removal finishes.
  const claim = `${lock}.${owner}.releasing`
  try {
    await mkdir(claim)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return false
    throw error
  }
  try {
    try {
      await unlink(path.join(lock, owner))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return false
      throw error
    }
    // Only the claim holder may remove this directory. Never recursively
    // remove a lock: unexpected/new ownership must survive.
    await rmdir(lock)
    return true
  }
  finally {
    await rmdir(claim)
  }
}

async function recoverDeadOwner(lock: string): Promise<boolean> {
  const entries = await readdir(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return []
    throw error
  })
  if (entries.length !== 1)
    return false
  const owner = entries[0]!
  const match = /^(\d+)-[\da-f-]{36}\.owner$/.exec(owner)
  if (!match)
    return false
  const pid = Number(match[1])
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return false
  try {
    process.kill(pid, 0)
    return false
  }
  catch (error) {
    // EPERM and reused/live PIDs are deliberately not treated as dead owners.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
      return false
  }
  return releaseOwner(lock, owner)
}

/** Serialize collection and publication, not just each atomic file replacement. */
export async function withTypePreparationLock<T>(cwd: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const identity = await resolveExistingPath(cwd)
  const lock = path.join(os.tmpdir(), `matrix-types-${createHash('sha256').update(identity).digest('hex')}.lock`)
  const owner = `${process.pid}-${randomUUID()}.owner`
  const deadline = Date.now() + 300_000
  while (true) {
    signal?.throwIfAborted()
    try {
      await mkdir(lock)
      break
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error
      if (await recoverDeadOwner(lock))
        continue
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for Matrix type preparation lock ${lock}. If ownership cannot be verified, remove this directory and its sibling ${path.basename(lock)}.*.releasing claim directories only after confirming no Matrix preparation or recovery is running. An interrupted recovery claim is never stolen automatically.`)
      try {
        await setTimeout(50, undefined, signal ? { signal } : {})
      }
      catch (error) {
        signal?.throwIfAborted()
        throw error
      }
    }
  }
  try {
    await writeFile(path.join(lock, owner), '', { flag: 'wx' })
  }
  catch (error) {
    try {
      if (!await releaseOwner(lock, owner))
        await rmdir(lock)
    }
    catch {
      // Preserve the original acquisition error.
    }
    throw error
  }
  let result: T
  try {
    signal?.throwIfAborted()
    result = await action()
  }
  catch (error) {
    // Cleanup must not replace the original failure or cancellation reason.
    await releaseOwner(lock, owner).catch(() => undefined)
    throw error
  }
  await releaseOwner(lock, owner)
  return result
}
