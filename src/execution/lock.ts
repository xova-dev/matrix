import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import path from 'pathe'
import { withCleanup } from '../utils/errors.js'
import { resolveExistingPath } from '../utils/path.js'

/** Inspection and removal share one owner; readers cannot race its retirement. */
async function withOwnerClaim(lock: string, owner: string, action: () => Promise<boolean>): Promise<boolean> {
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
  return withCleanup(action, () => rmdir(claim))
}

/** Only called while holding this owner's claim, never for a successor. */
async function removeOwner(lock: string, owner: string): Promise<boolean> {
  try {
    await unlink(path.join(lock, owner))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return false
    throw error
  }
  // Never recursively remove a lock: unexpected/new ownership must survive.
  await rmdir(lock)
  return true
}

async function releaseOwner(lock: string, owner: string): Promise<boolean> {
  return withOwnerClaim(lock, owner, () => removeOwner(lock, owner))
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
  return withOwnerClaim(lock, owner, async () => {
    const state = await readFile(path.join(lock, owner), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return undefined
      throw error
    })
    if (state === undefined)
      return false
    if (state !== '')
      throw new Error(`Matrix execution owner exited without confirming process cleanup. Refusing to recover ${lock}: target processes may still be using generated inputs. Stop all processes from that execution before manually removing this lock.`)
    return removeOwner(lock, owner)
  })
}

interface ExecutionLease {
  markExecuting: () => Promise<void>
  confirmStopped: () => void
}

/** Own shared workspace inputs through preparation, execution and process cleanup. */
export async function withExecutionLock<T>(cwd: string, action: (lease: ExecutionLease) => Promise<T>, signal?: AbortSignal): Promise<T> {
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
        throw new Error(`Timed out waiting for Matrix execution lock ${lock}. If ownership cannot be verified, remove this directory and its sibling ${path.basename(lock)}.*.releasing claim directories only after confirming no Matrix preparation or recovery is running. An interrupted recovery claim is never stolen automatically.`)
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
    return withCleanup(() => {
      throw error
    }, async () => {
      if (!await releaseOwner(lock, owner))
        await rmdir(lock)
    })
  }
  let releasable = true
  const lease: ExecutionLease = {
    async markExecuting() {
      releasable = false
      await writeFile(path.join(lock, owner), 'executing')
    },
    confirmStopped() {
      releasable = true
    },
  }
  return withCleanup(async () => {
    signal?.throwIfAborted()
    return action(lease)
  }, async () => {
    if (releasable)
      await releaseOwner(lock, owner)
  })
}
