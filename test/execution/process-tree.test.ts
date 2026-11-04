import { describe, expect, it } from 'vitest'
import { disposeProcesses } from '../../src/execution/process.js'

describe('process ownership', () => {
  it('waits for every owner even when roots exited and another owner failed', async () => {
    let release!: () => void
    const draining = new Promise<void>((resolve) => {
      release = resolve
    })
    const denied = new Error('Access denied')
    const first = { result: Promise.resolve(), dispose: async () => {
      throw denied
    } }
    const second = { result: Promise.resolve(), dispose: () => draining }
    let completed = false
    const outcome = disposeProcesses([first, second]).catch(error => error).finally(() => {
      completed = true
    })
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(completed).toBe(false)
    }
    finally {
      release()
      await outcome
    }
    expect(await outcome).toBe(denied)
  })
})
