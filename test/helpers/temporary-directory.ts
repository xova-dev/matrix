import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'pathe'
import { onTestFinished } from 'vitest'
import { cleanupTimeout } from './timeouts.js'

/** Register cleanup immediately, including when a later assertion fails. */
export async function temporaryDirectory(prefix: string, beforeRemove?: () => Promise<void>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  onTestFinished(async () => {
    await beforeRemove?.()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }, cleanupTimeout)
  return directory
}
