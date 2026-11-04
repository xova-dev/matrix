import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'pathe'
import { onTestFinished } from 'vitest'
import { settleAll } from '../../src/utils/errors.js'

export { settleAll as releaseResources } from '../../src/utils/errors.js'

interface TestResources {
  root: string
  signal: AbortSignal
  wait: <T>(operation: Promise<T>) => Promise<T>
  poll: <T>(check: () => T | Promise<T>, timeout?: number) => Promise<T>
  dispose: () => Promise<void>
  acquire: <T>(create: () => T | Promise<T>, release: (resource: T) => Promise<void>) => Promise<T>
}

/**
 * A test owns acquisitions as well as their results. Cancellation wakes waits,
 * starts disposal, and leaves directory removal to the joined finish hook.
 */
export async function testResources(testSignal: AbortSignal, prefix: string): Promise<TestResources> {
  const directory = mkdtemp(path.join(os.tmpdir(), prefix))
  const controller = new AbortController()
  const releases: (() => Promise<void>)[] = []
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      controller.abort(new Error('Test resources closed'))
      await settleAll(releases)
    })()
    return disposal
  }
  const cancel = (): void => {
    controller.abort(testSignal.reason)
    void dispose().catch(() => undefined)
  }
  testSignal.addEventListener('abort', cancel, { once: true })
  onTestFinished(async () => {
    testSignal.removeEventListener('abort', cancel)
    await dispose()
    await rm(await directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }, 60_000)
  if (testSignal.aborted)
    cancel()
  const root = await directory
  controller.signal.throwIfAborted()

  const wait = async <T>(operation: Promise<T>): Promise<T> => {
    // Always observe the supplied promise, including when already cancelled.
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abort, { once: true })
      if (controller.signal.aborted)
        abort()
    })
    try {
      const result = await Promise.race([operation, cancelled])
      controller.signal.throwIfAborted()
      return result
    }
    finally {
      controller.signal.removeEventListener('abort', abort)
    }
  }
  return {
    root,
    signal: controller.signal,
    wait,
    dispose,
    async poll<T>(check: () => T | Promise<T>, timeout = 15_000): Promise<T> {
      const deadline = Date.now() + timeout
      while (true) {
        controller.signal.throwIfAborted()
        try {
          return await wait(Promise.resolve().then(check))
        }
        catch (error) {
          controller.signal.throwIfAborted()
          if (Date.now() >= deadline)
            throw error
          await delay(10, undefined, { signal: controller.signal })
        }
      }
    },
    async acquire<T>(create: () => T | Promise<T>, release: (resource: T) => Promise<void>): Promise<T> {
      controller.signal.throwIfAborted()
      const acquired = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return create()
      })
      releases.push(async () => {
        // A failed acquisition has no resource; its error belongs to the caller.
        const result = await acquired.then(value => ({ value }), () => undefined)
        if (result)
          await release(result.value)
      })
      return wait(acquired)
    },
  }
}
