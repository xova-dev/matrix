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
  beforeClaim: async (_file: unknown) => {},
  afterClaim: async (_file: unknown, _error?: unknown) => {},
  afterUnlink: async (_file: unknown) => {},
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      const [file] = args
      await filesystem.beforeClaim(file)
      let failure: unknown
      let result: Awaited<ReturnType<typeof fs.mkdir>>
      try {
        result = await fs.mkdir(...args)
      }
      catch (error) {
        failure = error
      }
      await filesystem.afterClaim(file, failure)
      if (failure)
        throw failure
      return result
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
    const claim = `${lock}.${owner}.releasing`
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
    let releaseRemoval!: () => void
    const removal = new Promise<void>((resolve) => {
      releaseRemoval = resolve
    })
    const attemptedOwners: string[] = []
    filesystem.beforeClaim = async (file) => {
      if (file === claim) {
        // Hold later retries outside this three-contender election so scheduler
        // delays cannot turn two losing contenders into extra observations.
        if (attemptedOwners.length >= 3) {
          await removal
          return
        }
        attemptedOwners.push(file)
        if (attemptedOwners.length === 3)
          allAttempting()
        await attempts
      }
    }
    let allAttempted!: () => void
    const attempted = new Promise<void>((resolve) => {
      allAttempted = resolve
    })
    const outcomes: Array<string | undefined> = []
    filesystem.afterClaim = async (file, error) => {
      if (file === claim) {
        outcomes.push((error as NodeJS.ErrnoException | undefined)?.code)
        if (outcomes.length === 3)
          allAttempted()
      }
    }
    let ownerRemoved!: () => void
    const removed = new Promise<void>((resolve) => {
      ownerRemoved = resolve
    })
    let removals = 0
    filesystem.afterUnlink = async (file) => {
      if (typeof file === 'string' && path.basename(file) === owner) {
        removals++
        ownerRemoved()
        await removal
      }
    }
    const controller = new AbortController()
    let phase = 'waiting for three verified recovery claims'
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
      // All contenders verified the same dead owner before trying the claim.
      // Election must finish before any contender can unlink the owner marker.
      expect(attemptedOwners).toEqual(Array.from({ length: 3 }).fill(claim))
      expect(kill.mock.calls.filter(([pid]) => pid === 2147483647)).toHaveLength(3)
      phase = 'waiting for one claim winner and two existing-claim results'
      releaseAttempts()
      await Promise.race([attempted, prematureCompletion, aborted])
      expect(outcomes.filter(code => code === undefined)).toHaveLength(1)
      expect(outcomes.filter(code => code === 'EEXIST')).toHaveLength(2)
      phase = 'waiting for the claim holder to remove the marker'
      await Promise.race([removed, prematureCompletion, aborted])
      expect(removals).toBe(1)
      expect(entered).toBe(0)
      // Losing recoverers must leave the now-empty directory for the winner.
      expect(await readdir(lock)).toEqual([])
      expect(await readdir(claim)).toEqual([])
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
      filesystem.beforeClaim = async () => {}
      filesystem.afterClaim = async () => {}
      filesystem.afterUnlink = async () => {}
      await rm(claim, { recursive: true, force: true })
      await rm(lock, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  }, 10_000)

  it('leaves a live successor untouched when a stale recovery claims late', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-late-recovery-'))
    const identity = await resolveExistingPath(cwd)
    const lock = path.join(os.tmpdir(), `matrix-types-${createHash('sha256').update(identity).digest('hex')}.lock`)
    const owner = `2147483647-${randomUUID()}.owner`
    const claim = `${lock}.${owner}.releasing`
    await mkdir(lock)
    await writeFile(path.join(lock, owner), '')
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 2147483647)
        throw Object.assign(new Error('dead owner'), { code: 'ESRCH' })
      return true
    })
    let releaseClaim!: () => void
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve
    })
    let attempts = 0
    filesystem.beforeClaim = async (file) => {
      if (file === claim && ++attempts === 1)
        await claimGate
    }
    let releaseAction!: () => void
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve
    })
    let entered = 0
    const controller = new AbortController()
    const successors = [1, 2].map(value => withTypePreparationLock(cwd, async () => {
      entered++
      await actionGate
      return value
    }, controller.signal))
    const settled = Promise.allSettled(successors)
    try {
      await expect.poll(() => entered).toBe(1)
      const successorOwner = await readdir(lock)
      expect(successorOwner).toHaveLength(1)
      expect(successorOwner).not.toContain(owner)
      // The first recoverer resumes only after another contender has retired
      // the original lock, removed its claim, and acquired a new generation.
      let retried = false
      waiting.notify = () => {
        retried = true
      }
      releaseClaim()
      await expect.poll(() => retried).toBe(true)
      expect(await readdir(lock)).toEqual(successorOwner)
      expect(entered).toBe(1)
    }
    finally {
      controller.abort()
      releaseClaim()
      releaseAction()
      await settled
      filesystem.beforeClaim = async () => {}
      waiting.notify = () => {}
      kill.mockRestore()
      await rm(claim, { recursive: true, force: true })
      await rm(lock, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('fails closed on an abandoned recovery claim and explains manual cleanup', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-recovery-claim-'))
    const identity = await resolveExistingPath(cwd)
    const lock = path.join(os.tmpdir(), `matrix-types-${createHash('sha256').update(identity).digest('hex')}.lock`)
    const owner = `2147483647-${randomUUID()}.owner`
    const claim = `${lock}.${owner}.releasing`
    await mkdir(lock)
    await writeFile(path.join(lock, owner), '')
    await mkdir(claim)
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 2147483647)
        throw Object.assign(new Error('dead owner'), { code: 'ESRCH' })
      return true
    })
    let time = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => time += 300_001)
    try {
      await expect(withTypePreparationLock(cwd, async () => {
        throw new Error('An abandoned claim must not be stolen')
      })).rejects.toThrow(`sibling ${path.basename(lock)}.*.releasing claim directories`)
      expect(await readdir(lock)).toEqual([owner])
      expect(await readdir(claim)).toEqual([])
      now.mockRestore()
      // Simulate the documented manual cleanup after confirming no recovery
      // is running, then ensure the still-present dead owner is recoverable.
      await rm(claim, { recursive: true })
      await expect(withTypePreparationLock(cwd, async () => 'recovered')).resolves.toBe('recovered')
    }
    finally {
      now.mockRestore()
      kill.mockRestore()
      await rm(claim, { recursive: true, force: true })
      await rm(lock, { recursive: true, force: true })
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
