import { describe, expect, it } from 'vitest'
import { ExecutionSession } from '../../src/execution/session.js'
import { withCleanup } from '../../src/utils/errors.js'
import { temporaryDirectory } from '../helpers/temporary-directory.js'

describe('session process ownership', () => {
  it('retains claims after root exit and joins one disposal on concurrent shutdown', async () => {
    const root = await temporaryDirectory('matrix-session-')
    const session = new ExecutionSession()
    let release!: () => void
    let disposals = 0
    const draining = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = await session.start('first', 'command', [{ path: root, access: 'write' }], () => ({
      result: Promise.resolve({ exitCode: 0 }),
      dispose: () => {
        disposals++
        return draining
      },
    }))
    await withCleanup(async () => {
      let spawned = false
      await expect(session.start('second', 'host', [{ path: root, access: 'write' }], () => {
        spawned = true
        throw new Error('must not spawn')
      })).rejects.toThrow('overlapping')
      expect(spawned).toBe(false)
      const stopped = session.stop()
      let completed = false
      void stopped.then(() => {
        completed = true
      })
      await Promise.resolve()
      expect(completed).toBe(false)
    }, async () => {
      release()
      await session.stop()
      await running.completion
    })
    expect(disposals).toBe(1)
  })

  it('keeps resources unavailable when the backend cannot certify disposal', async () => {
    const root = await temporaryDirectory('matrix-session-')
    const session = new ExecutionSession()
    const running = await session.start('first', 'command', [{ path: root, access: 'write' }], () => ({
      result: Promise.resolve({ exitCode: 0 }),
      dispose: async () => { throw new Error('uncertain descendants') },
    }))
    await expect(running.completion).rejects.toThrow('uncertain descendants')
    await expect(session.use('publish', [{ path: root, access: 'write' }], async () => {})).rejects.toThrow('overlapping')
    await expect(session.stop()).rejects.toThrow('uncertain descendants')
  })

  it('performs cooperative shutdown before backend disposal and releases the next context afterwards', async () => {
    const root = await temporaryDirectory('matrix-session-')
    const session = new ExecutionSession()
    const events: string[] = []
    const running = await session.start('host', 'host', [{ path: root, access: 'write' }], () => ({
      result: Promise.resolve({ exitCode: 0 }),
      dispose: async () => { events.push('dispose') },
    }), undefined, async () => { events.push('framework-close') })
    await running.completion
    await session.use('next-product', [{ path: root, access: 'write' }], async () => {
      events.push('next')
    })
    expect(events).toEqual(['framework-close', 'dispose', 'next'])
    await session.stop()
  })

  it('preserves operation, framework and backend failures through final shutdown', async () => {
    const root = await temporaryDirectory('matrix-session-failures-')
    const session = new ExecutionSession()
    const operation = new Error('host failed')
    const framework = new Error('framework close failed')
    const backend = new Error('container release failed')
    const calls: string[] = []
    await expect(session.within(undefined, async () => {
      const running = await session.start('host', 'host', [{ path: root, access: 'write' }], () => ({
        result: Promise.reject(operation),
        dispose: async () => {
          calls.push('backend')
          throw backend
        },
      }), undefined, async () => {
        calls.push('framework')
        throw framework
      })
      await running.completion
    }, new AbortController().signal, () => {})).rejects.toMatchObject({ errors: [operation, framework, backend] })
    expect(calls).toEqual(['framework', 'backend'])
    expect(session.stopping).toBe(true)
  })

  it('joins separate cleanup batches and preserves both failures on concurrent stop', async () => {
    const session = new ExecutionSession()
    const firstError = new Error('first cleanup')
    const secondError = new Error('second cleanup')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = await session.start('first', 'command', [], () => ({
      result: Promise.resolve({ exitCode: 0 }),
      dispose: async () => { throw firstError },
    }))
    await expect(first.completion).rejects.toBe(firstError)
    const second = await session.start('second', 'command', [], () => ({
      result: Promise.resolve({ exitCode: 0 }),
      dispose: async () => {
        await gate
        throw secondError
      },
    }))
    const outcome = session.stop().catch(error => error)
    let settled = false
    void outcome.then(() => {
      settled = true
    })
    await withCleanup(async () => {
      expect(session.stop()).toBe(session.stop())
      await Promise.resolve()
      expect(settled).toBe(false)
    }, async () => {
      release()
      await outcome
      await second.completion.catch(() => undefined)
    })
    expect((await outcome).errors).toEqual([firstError, secondError])
  })

  it('releases claims and the workspace lock after an operation fails but cleanup succeeds', async () => {
    const root = await temporaryDirectory('matrix-session-operation-')
    const session = new ExecutionSession()
    const original = new Error('command rejected')
    const signal = new AbortController().signal
    const execute = () => session.within(root, async () => {
      const running = await session.start('command', 'command', [{ path: root, access: 'write' }], () => ({
        result: Promise.reject(original),
        dispose: async () => {},
      }))
      await expect(running.completion).rejects.toBe(original)
      await session.use('next context', [{ path: root, access: 'write' }], async () => {})
      throw original
    }, signal, () => { throw new Error('unexpected cleanup failure') })
    await expect(execute()).rejects.toBe(original)
    await expect(new ExecutionSession().within(root, async () => 'reacquired', signal, () => {})).resolves.toBe('reacquired')
  })
})
