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
  afterRead: async (_file: unknown) => {},
  afterUnlink: async (_file: unknown) => {},
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readdir: async (file: Parameters<typeof fs.readdir>[0]) => {
      const entries = await fs.readdir(file)
      await filesystem.afterRead(file)
      return entries
    },
    unlink: async (file: Parameters<typeof fs.unlink>[0]) => {
      await fs.unlink(file)
      await filesystem.afterUnlink(file)
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
    let releaseReads!: () => void
    const reads = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    let readCount = 0
    filesystem.afterRead = async (file) => {
      if (file === lock && ++readCount <= 3) {
        if (readCount === 3)
          releaseReads()
        await reads
      }
    }
    let releaseRemoval!: () => void
    const removal = new Promise<void>((resolve) => {
      releaseRemoval = resolve
    })
    let successfulRemovers = 0
    filesystem.afterUnlink = async (file) => {
      if (file === path.join(lock, owner)) {
        successfulRemovers++
        await removal
      }
    }
    let waitingCount = 0
    let losersWaiting!: () => void
    const losers = new Promise<void>((resolve) => {
      losersWaiting = resolve
    })
    waiting.notify = () => {
      if (++waitingCount === 2)
        losersWaiting()
    }
    let entered = 0
    let active = 0
    let maximum = 0
    const successors = [1, 2, 3].map(value => withTypePreparationLock(cwd, async () => {
      entered++
      maximum = Math.max(maximum, ++active)
      await setImmediate()
      active--
      return value
    }, AbortSignal.timeout(5_000)))
    try {
      await losers
      expect(successfulRemovers).toBe(1)
      expect(entered).toBe(0)
      // Losing recoverers must leave the now-empty directory for the winner.
      expect(await readdir(lock)).toEqual([])
      releaseRemoval()
      expect(await Promise.all(successors)).toEqual([1, 2, 3])
      expect(maximum).toBe(1)
    }
    finally {
      releaseReads()
      releaseRemoval()
      await Promise.allSettled(successors)
      kill.mockRestore()
      filesystem.afterRead = async () => {}
      filesystem.afterUnlink = async () => {}
      waiting.notify = () => {}
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
