import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { execa } from 'execa'
import { expect, vi } from 'vitest'
import { settleAll } from '../../src/utils/errors.js'

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH')
      return false
    throw error
  }
}

/** No live consumer remains; an orphan's eventual reaping belongs to its parent. */
export async function expectProcessStopped(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    expect(processExists(pid)).toBe(false)
    return
  }
  const { stdout } = await execa('ps', ['-A', '-o', 'pid=,stat='])
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/))
  const state = rows.find(([id]) => Number(id) === pid)?.[1]
  expect(state === undefined || state.startsWith('Z'), `Fixture process ${pid} is still active (state: ${state})`).toBe(true)
}

/** Failure fallback for known fixture PIDs; never a production ownership backend. */
export async function releaseRecordedProcesses(files: string[]): Promise<void> {
  await settleAll(files.map(file => async () => {
    const text = await readFile(file, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT')
        throw error
      return undefined
    })
    if (text === undefined)
      return
    const pid = Number(text)
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error(`Invalid fixture PID in ${file}`)
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        throw error
    }
    await vi.waitFor(() => expectProcessStopped(pid), { timeout: 5_000 })
  }))
}
