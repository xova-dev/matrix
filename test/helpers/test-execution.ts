import process from 'node:process'
import { throwFailures } from '../../src/utils/errors.js'

interface TestExecution {
  begin: (testSignal: AbortSignal) => void
  run: <T>(operation: () => Promise<T>, stop?: () => void) => Promise<T>
  cleanup: () => Promise<void>
}

/**
 * Own real executions until they settle, including after Vitest aborts a test.
 * Call cleanup first in afterEach, before restoring cwd/mocks or removing files.
 */
export function createTestExecution(): TestExecution {
  let signal: AbortSignal
  let exitCode: typeof process.exitCode
  let finished = true
  const running = new Map<Promise<unknown>, () => void>()
  const cancellationErrors: unknown[] = []
  const terminate = (): void => {
    process.emit('SIGTERM')
  }
  const cancel = (): void => {
    for (const stop of new Set(running.values())) {
      try {
        stop()
      }
      catch (error) {
        cancellationErrors.push(error)
      }
    }
  }
  // CLI config loading precedes its execution session's signal handlers.
  // Deliver an already requested cancellation when that session is installed.
  const listenerAdded = (event: string | symbol): void => {
    if (event === 'SIGTERM') {
      queueMicrotask(() => {
        if ((signal.aborted || finished) && running.size)
          cancel()
      })
    }
  }
  return {
    begin(testSignal: AbortSignal): void {
      if (running.size)
        throw new Error('Previous test executions have not been drained')
      signal = testSignal
      exitCode = process.exitCode
      finished = false
      cancellationErrors.length = 0
      signal.addEventListener('abort', cancel)
      process.on('newListener', listenerAdded)
    },
    async run<T>(operation: () => Promise<T>, stop: () => void = terminate): Promise<T> {
      signal.throwIfAborted()
      if (finished)
        throw new Error('Test execution has already been cleaned up')
      const pending = operation()
      running.set(pending, stop)
      if (signal.aborted)
        cancel()
      let result: T
      try {
        result = await pending
      }
      catch (error) {
        if (signal.aborted || finished)
          cancellationErrors.push(error)
        throw error
      }
      finally {
        running.delete(pending)
      }
      signal.throwIfAborted()
      return result
    },
    async cleanup(): Promise<void> {
      finished = true
      cancel()
      // Retain cancellation failures even when run settled before this hook:
      // Vitest may have already abandoned the timed-out test's promise.
      const outcomes = await Promise.allSettled(running.keys())
      signal.removeEventListener('abort', cancel)
      process.removeListener('newListener', listenerAdded)
      process.exitCode = exitCode
      const errors = [...new Set([...cancellationErrors, ...outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : [])])]
      throwFailures(errors)
    },
  }
}
