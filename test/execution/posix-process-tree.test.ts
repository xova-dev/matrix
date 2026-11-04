import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopProcessGroups as stopProcessTrees } from '../../src/execution/process-tree.js'

// Exercise process-table and signal races without relying on the host's reaper.
const { inspect, kill } = vi.hoisted(() => ({ inspect: vi.fn(), kill: vi.fn() }))
vi.mock('execa', () => ({ execa: inspect }))
vi.mock('node:process', () => ({
  default: { platform: 'darwin', kill },
}))

function exitedChild() {
  return Object.assign(Promise.resolve(), { pid: 101 }) as unknown as Parameters<typeof stopProcessTrees>[0][number]
}

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('posix process-tree completion', () => {
  it('releases a group containing only zombies without sending termination signals', async () => {
    kill.mockImplementation((_pid, signal) => {
      if (signal !== 0)
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      return true
    })
    inspect.mockResolvedValue({ stdout: '101 Z\n202 S\n' })
    const child = exitedChild()
    await stopProcessTrees([child])
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
  })

  it('rechecks liveness when the last member exits between inspection and signalling', async () => {
    kill.mockImplementation((_pid, signal) => {
      if (signal !== 0)
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      return true
    })
    inspect.mockResolvedValueOnce({ stdout: '101 S\n' })
      .mockResolvedValue({ stdout: '101 Z\n' })
    const child = exitedChild()
    await stopProcessTrees([child])
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[-101, 'SIGTERM']])
  })

  it('retains a permission failure when inspection still finds a live consumer', async () => {
    vi.useFakeTimers()
    const permission = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    kill.mockImplementation((_pid, signal) => {
      if (signal !== 0)
        throw permission
      return true
    })
    inspect.mockResolvedValue({ stdout: '101 S\n' })
    const child = exitedChild()
    const outcome = stopProcessTrees([child]).catch(error => error)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(await outcome).toMatchObject({ cause: permission })
  })
})
