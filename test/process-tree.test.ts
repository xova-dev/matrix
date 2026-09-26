import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopProcessTrees } from '../src/process-tree.js'

// Mock only OS boundaries so Windows failure coordination is exercised on every OS.
const { taskkill } = vi.hoisted(() => ({ taskkill: vi.fn() }))
vi.mock('execa', () => ({ execa: taskkill }))
vi.mock('node:process', () => ({
  default: { platform: 'win32', env: { SystemRoot: 'C:/Windows' }, kill: () => true },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function child(pid: number) {
  const { promise, resolve } = deferred<void>()
  return {
    process: Object.assign(promise, { pid }) as unknown as Parameters<typeof stopProcessTrees>[0][number],
    exit: () => resolve(),
  }
}

afterEach(() => {
  vi.useRealTimers()
  taskkill.mockReset()
})

describe('windows process-tree shutdown', () => {
  it('waits for other termination commands and child exits before reporting a failure', async () => {
    vi.useFakeTimers()
    const first = child(101)
    const second = child(102)
    const delayedKill = deferred<{ failed: boolean }>()
    taskkill.mockResolvedValueOnce({ failed: true, stderr: 'Access denied' })
      .mockReturnValueOnce(delayedKill.promise)
    let completed = false
    const outcome = stopProcessTrees([first.process, second.process], new Set()).catch((error: unknown) => error).finally(() => {
      completed = true
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toBe(false)
    first.exit()
    delayedKill.resolve({ failed: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toBe(false)
    second.exit()

    const error = await outcome as AggregateError
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([expect.objectContaining({ message: expect.stringContaining('Access denied') })])
  })

  it('bounds the exit wait and preserves termination failures when a child never exits', async () => {
    vi.useFakeTimers()
    const running = child(103)
    taskkill.mockResolvedValueOnce({ failed: true, stderr: 'Access denied' })
    const outcome = stopProcessTrees([running.process], new Set()).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(6_000)

    const error = await outcome as AggregateError
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('Access denied') }),
      expect.objectContaining({ message: expect.stringContaining('Timed out') }),
    ])
    running.exit()
  })
})
