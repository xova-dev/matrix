import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import { setImmediate } from 'node:timers/promises'
import path from 'pathe'
import { describe, expect, it, vi } from 'vitest'
import { hasPreparedTypeContract } from '../../src/typegen/coordination.js'
import { withTypePreparationLock } from '../../src/typegen/lock.js'
import { TypePreparationCancelled } from '../../src/typegen/prepare.js'

const waiting = vi.hoisted(() => ({ notify: () => {} }))

vi.mock('node:timers/promises', async (importOriginal) => {
  const timers = await importOriginal<typeof import('node:timers/promises')>()
  return {
    ...timers,
    setTimeout: (...args: Parameters<typeof timers.setTimeout>) => {
      const pending = timers.setTimeout(...args)
      waiting.notify()
      return pending
    },
  }
})

function nextLockWait(): Promise<void> {
  return new Promise((resolve) => {
    waiting.notify = resolve
  })
}

describe('type preparation coordination', () => {
  it.each([null, {}, { strict: true, declarations: [null] }, { strict: true, declarations: [{ output: '/file', signature: '', keys: [42] }] }])('rejects malformed internal contracts clearly: %j', (contract) => {
    expect(() => hasPreparedTypeContract(JSON.stringify(contract), { cwd: '/project', env: {} })).toThrow('Invalid Matrix internal type contract')
  })

  it('serializes collection and preserves cancellation while waiting without stealing the owner lock', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-lock-'))
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = withTypePreparationLock(cwd, async () => {
      started()
      await gate
      return 'first'
    })
    try {
      await entered
      const controller = new AbortController()
      const reason = new TypePreparationCancelled('cancelled')
      let secondEntered = false
      const secondWaiting = nextLockWait()
      const second = withTypePreparationLock(cwd, async () => {
        secondEntered = true
      }, controller.signal)
      // This notification is emitted only after mkdir rejected with EEXIST
      // and the abortable retry timer was installed.
      await secondWaiting
      controller.abort(reason)
      await expect(second).rejects.toBe(reason)
      expect(secondEntered).toBe(false)
      let thirdEntered = false
      const thirdWaiting = nextLockWait()
      const third = withTypePreparationLock(cwd, async () => {
        thirdEntered = true
        return 'third'
      })
      await thirdWaiting
      expect(thirdEntered).toBe(false)
      release()
      await expect(first).resolves.toBe('first')
      await expect(third).resolves.toBe('third')
    }
    finally {
      release()
      await first
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('recovers a killed process owner and serializes competing successors', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-dead-lock-'))
    const lockModule = new URL('../../src/typegen/lock.ts', import.meta.url).href
    const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        try { return next(specifier, context); }
        catch (error) {
          if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error;
          return next(specifier.slice(0, -3) + '.ts', context);
        }
      } });
      const { withTypePreparationLock } = await import(${JSON.stringify(lockModule)});
      await withTypePreparationLock(${JSON.stringify(cwd)}, async () => {
        process.stdout.write('locked');
        await new Promise(() => { setInterval(() => {}, 1000); });
      });
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    try {
      await Promise.race([
        once(child.stdout!, 'data'),
        exited.then(() => { throw new Error('Lock owner exited before acquiring its lock') }),
      ])
      child.kill('SIGKILL')
      await exited
      let active = 0
      let maximum = 0
      const successors = [1, 2, 3].map(value => withTypePreparationLock(cwd, async () => {
        active++
        maximum = Math.max(maximum, active)
        await setImmediate()
        active--
        return value
      }, AbortSignal.timeout(5_000)))
      expect(await Promise.all(successors)).toEqual([1, 2, 3])
      expect(maximum).toBe(1)
      // Normal release still permits a later invocation to acquire the lock.
      await expect(withTypePreparationLock(cwd, async () => 'released')).resolves.toBe('released')
    }
    finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
      await exited
      await rm(cwd, { recursive: true, force: true })
    }
  }, 10_000)
})
