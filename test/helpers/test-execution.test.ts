import { access, rm } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { settleAll, withCleanup } from '../../src/utils/errors.js'
import { temporaryDirectory } from './temporary-directory.js'
import { createTestExecution } from './test-execution.js'

describe('test execution ownership', () => {
  it('drains cancellation before restoring global state and prevents later execution', async () => {
    const execution = createTestExecution()
    const controller = new AbortController()
    const previousExitCode = process.exitCode
    execution.begin(controller.signal)
    let release!: () => void
    let cancelled = false
    let drained = false
    const pending = execution.run(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      process.exitCode = 143
    }, () => { cancelled = true })
    controller.abort()
    const rejected = expect(pending).rejects.toBe(controller.signal.reason)
    const cleanup = execution.cleanup().then(() => {
      drained = true
    })
    onTestFinished(async () => {
      release()
      await settleAll([() => cleanup, () => rejected])
    })
    await setImmediate()
    expect(cancelled).toBe(true)
    expect(drained).toBe(false)
    release()
    await cleanup
    await rejected
    expect(process.exitCode).toBe(previousExitCode)
    let started = false
    await expect(execution.run(async () => {
      started = true
    })).rejects.toBe(controller.signal.reason)
    expect(started).toBe(false)
  })

  it.each([false, true])('delivers cancellation to a session installed after test timeout (custom stop: %s)', async (customStop) => {
    const execution = createTestExecution()
    const controller = new AbortController()
    execution.begin(controller.signal)
    let install!: () => void
    let stopped = false
    let stop!: () => void
    const pending = execution.run(async () => {
      await new Promise<void>((resolve) => {
        install = resolve
      })
      await new Promise<void>((resolve) => {
        stop = () => {
          stopped = true
          resolve()
        }
        process.once('SIGTERM', stop)
      })
    }, customStop
      ? () => {
          install()
          process.emit('SIGTERM')
        }
      : undefined)
    controller.abort()
    const rejected = expect(pending).rejects.toBe(controller.signal.reason)
    onTestFinished(async () => {
      install()
      await Promise.resolve()
      stop?.()
      if (stop)
        process.removeListener('SIGTERM', stop)
      await execution.cleanup()
      await rejected
    })
    install()
    await rejected
    expect(stopped).toBe(true)
  })

  it('preserves the original execution failure during cancellation', async () => {
    const execution = createTestExecution()
    const controller = new AbortController()
    execution.begin(controller.signal)
    const failure = new Error('original worker failure')
    let fail!: (error: Error) => void
    const pending = execution.run(() => new Promise<void>((_resolve, reject) => {
      fail = reject
    }), () => { fail(failure) })
    controller.abort()
    await withCleanup(async () => {
      await expect(pending).rejects.toBe(failure)
      await setImmediate()
    }, () => expect(execution.cleanup()).rejects.toBe(failure))
  })

  it('reports a pending cancellation failure from cleanup as well as execution', async () => {
    const execution = createTestExecution()
    const controller = new AbortController()
    execution.begin(controller.signal)
    const failure = new Error('could not release worker')
    let fail!: (error: Error) => void
    const pending = execution.run(() => new Promise<void>((_resolve, reject) => {
      fail = reject
    }), () => { fail(failure) })
    const rejected = expect(pending).rejects.toBe(failure)
    await expect(execution.cleanup()).rejects.toBe(failure)
    await rejected
  })

  it('releases every execution gate on timeout even when one stop callback fails', async () => {
    const execution = createTestExecution()
    const controller = new AbortController()
    execution.begin(controller.signal)
    const failure = new Error('stop callback failed')
    const released: number[] = []
    const running = [0, 1].map((index) => {
      let release!: () => void
      return execution.run(async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        released.push(index)
      }, () => {
        release()
        if (index === 0)
          throw failure
      })
    })
    onTestFinished(() => execution.cleanup().catch((error) => {
      if (error !== failure)
        throw error
    }))
    const reason = new Error('test timeout')
    const rejected = running.map(pending => expect(pending).rejects.toBe(reason))
    controller.abort(reason)
    await expect(execution.cleanup()).rejects.toBe(failure)
    await Promise.all(rejected)
    expect([...released].sort()).toEqual([0, 1])
  })

  it('restores global state after failed cleanup without deleting the uncertain fixture', async () => {
    const root = await temporaryDirectory('matrix-execution-restoration-')
    const previousCwd = process.cwd()
    const listeners = process.listenerCount('newListener')
    const execution = createTestExecution()
    const controller = new AbortController()
    const failure = new Error('resource release failed')
    const cleanup = withCleanup(async () => {
      execution.begin(controller.signal)
      process.chdir(root)
      let reject!: (error: Error) => void
      const pending = execution.run(() => new Promise<void>((_resolve, fail) => {
        reject = fail
      }), () => reject(failure))
      void pending.catch(() => undefined)
      controller.abort()
      await execution.cleanup()
    }, () => process.chdir(previousCwd)).then(() => rm(root, { recursive: true, force: true }))
    await expect(cleanup).rejects.toBe(failure)
    expect(process.cwd()).toBe(previousCwd)
    expect(process.listenerCount('newListener')).toBe(listeners)
    await access(root)
  })
})
