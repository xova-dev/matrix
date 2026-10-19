import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { setImmediate } from 'node:timers/promises'
import path from 'pathe'
import { describe, expect, it, vi } from 'vitest'
import { hasPreparedTypeContract } from '../../src/typegen/coordination.js'
import { withTypePreparationLock } from '../../src/typegen/lock.js'
import { TypePreparationCancelled } from '../../src/typegen/prepare.js'
import { resolveExistingPath } from '../../src/utils/path.js'

const waiting = vi.hoisted(() => ({ notify: () => {} }))

const filesystem = vi.hoisted(() => ({
  beforeUnlink: async (_file: unknown) => {},
  afterUnlink: async (_file: unknown, _error?: unknown) => {},
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    unlink: async (file: Parameters<typeof fs.unlink>[0]) => {
      await filesystem.beforeUnlink(file)
      let failure: unknown
      try {
        await fs.unlink(file)
      }
      catch (error) {
        failure = error
      }
      await filesystem.afterUnlink(file, failure)
      if (failure)
        throw failure
    },
  }
})

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

  it('elects exactly one remover when three recoverers read the same dead owner', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-recovery-race-'))
    const identity = await resolveExistingPath(cwd)
    const lock = path.join(os.tmpdir(), `matrix-types-${createHash('sha256').update(identity).digest('hex')}.lock`)
    const owner = `2147483647-${randomUUID()}.owner`
    await mkdir(lock)
    await writeFile(path.join(lock, owner), '')
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 2147483647)
        throw Object.assign(new Error('dead owner'), { code: 'ESRCH' })
      return true
    })
    let releaseAttempts!: () => void
    const attempts = new Promise<void>((resolve) => {
      releaseAttempts = resolve
    })
    let allAttempting!: () => void
    const attempting = new Promise<void>((resolve) => {
      allAttempting = resolve
    })
    const attemptedOwners: string[] = []
    filesystem.beforeUnlink = async (file) => {
      if (typeof file === 'string' && path.basename(file) === owner) {
        attemptedOwners.push(file)
        if (attemptedOwners.length === 3)
          allAttempting()
        await attempts
      }
    }
    let releaseRemoval!: () => void
    const removal = new Promise<void>((resolve) => {
      releaseRemoval = resolve
    })
    let allAttempted!: () => void
    const attempted = new Promise<void>((resolve) => {
      allAttempted = resolve
    })
    const outcomes: Array<string | undefined> = []
    filesystem.afterUnlink = async (file, error) => {
      if (typeof file === 'string' && path.basename(file) === owner) {
        outcomes.push((error as NodeJS.ErrnoException | undefined)?.code)
        if (outcomes.length === 3)
          allAttempted()
        if (!error)
          await removal
      }
    }
    const controller = new AbortController()
    let phase = 'waiting for three verified owner-removal attempts'
    const watchdog = setTimeout(() => {
      controller.abort(new Error(`Recovery test stalled ${phase}; attempts=${attemptedOwners.length}, outcomes=${JSON.stringify(outcomes)}`))
    }, 5_000)
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    let entered = 0
    let active = 0
    let maximum = 0
    const successors = [1, 2, 3].map(value => withTypePreparationLock(cwd, async () => {
      entered++
      maximum = Math.max(maximum, ++active)
      await setImmediate()
      active--
      return value
    }, controller.signal))
    const completed = Promise.all(successors)
    const prematureCompletion = completed.then(() => {
      throw new Error(`Successors completed prematurely ${phase}`)
    })
    try {
      await Promise.race([attempting, prematureCompletion, aborted])
      // Each contender already read and verified the same dead owner before
      // reaching unlink; no read barriers or retry-timer ordering are assumed.
      expect(attemptedOwners).toEqual(Array.from({ length: 3 }, () => path.join(lock, owner)))
      expect(kill.mock.calls.filter(([pid]) => pid === 2147483647)).toHaveLength(3)
      phase = 'waiting for one successful unlink and two missing-owner results'
      releaseAttempts()
      await Promise.race([attempted, prematureCompletion, aborted])
      expect(outcomes.filter(code => code === undefined)).toHaveLength(1)
      expect(outcomes.filter(code => code === 'ENOENT')).toHaveLength(2)
      expect(entered).toBe(0)
      // Losing recoverers must leave the now-empty directory for the winner.
      expect(await readdir(lock)).toEqual([])
      phase = 'waiting for serialized successors'
      releaseRemoval()
      expect(await Promise.race([completed, aborted])).toEqual([1, 2, 3])
      expect(maximum).toBe(1)
    }
    finally {
      clearTimeout(watchdog)
      // Always release mock gates before awaiting cleanup, including failures
      // before all contenders arrive. Observe every successor rejection.
      controller.abort()
      releaseAttempts()
      releaseRemoval()
      await Promise.allSettled([...successors, prematureCompletion, aborted])
      kill.mockRestore()
      filesystem.beforeUnlink = async () => {}
      filesystem.afterUnlink = async () => {}
      await rm(lock, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  }, 10_000)

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
