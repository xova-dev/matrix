import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'pathe'
import { onTestFinished } from 'vitest'

/** Register cleanup immediately, including when a later assertion fails. */
export async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  return directory
}
