import { access, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'pathe'
import { describe, expect, it } from 'vitest'
import { startProcess } from '../../src/execution/process.js'
import { releaseResources, testResources } from './test-resources.js'

describe('test resource ownership', () => {
  it('wakes an unanswered wait on timeout and joins disposal before directory cleanup', async () => {
    const controller = new AbortController()
    const resources = await testResources(controller.signal, 'matrix-timeout-')
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    let disposing = false
    try {
      await resources.acquire(() => ({}), async () => {
        disposing = true
        await gate
      })
      const pending = resources.wait(new Promise<never>(() => {}))
      const reason = new Error('test timeout')
      controller.abort(reason)
      await expect(pending).rejects.toBe(reason)
      let drained = false
      const cleanup = resources.dispose()
      void cleanup.then(() => {
        drained = true
      }, () => {})
      await setImmediate()
      expect(disposing).toBe(true)
      expect(drained).toBe(false)
      await access(resources.root)
      finish()
      await cleanup
      let started = false
      await expect(resources.acquire(() => {
        started = true
      }, async () => {})).rejects.toBe(reason)
      expect(started).toBe(false)
    }
    finally {
      finish()
    }
  })

  it('owns a resource whose acquisition finishes after cancellation', async () => {
    const controller = new AbortController()
    const resources = await testResources(controller.signal, 'matrix-late-resource-')
    let acquired!: (value: string) => void
    const gate = new Promise<string>((resolve) => {
      acquired = resolve
    })
    const released: string[] = []
    const pending = resources.acquire(() => gate, async (value) => {
      released.push(value)
    })
    try {
      await setImmediate()
      controller.abort()
      await expect(pending).rejects.toBe(controller.signal.reason)
      acquired('late worker')
      await resources.dispose()
      expect(released).toEqual(['late worker'])
    }
    finally {
      acquired('late worker')
    }
  })

  it('joins independent cleanup after a synchronous failure and retains every error', async () => {
    const first = new Error('supervisor failed')
    const second = new Error('PID recovery failed')
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    let independentReleased = false
    let settled = false
    const outcome = releaseResources([
      () => { throw first },
      async () => {
        await gate
        throw second
      },
      async () => {
        independentReleased = true
      },
    ]).catch(error => error).finally(() => {
      settled = true
    })
    try {
      await setImmediate()
      expect(independentReleased).toBe(true)
      expect(settled).toBe(false)
    }
    finally {
      finish()
    }
    expect((await outcome).errors).toEqual([first, second])
  })

  it.for(['timeout', 'cleanup failure', 'outer cancellation', 'early cancellation'])('owns the isolated runner through %s', { timeout: 60_000 }, async (failure, ctx) => {
    const cancellation = new AbortController()
    const resources = await testResources(AbortSignal.any([ctx.signal, cancellation.signal]), 'matrix-timeout-runner-')
    const { root } = resources
    // Parent ownership precedes every child allocation; receipts are observations only.
    const temporaryRoot = path.join(root, 'temporary')
    await mkdir(temporaryRoot)
    await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(root, 'node_modules'), 'junction')
    await writeFile(path.join(root, 'vitest.config.mjs'), `export default {
      test: { include: ['timeout.test.ts'], reporters: ['json'], outputFile: 'result.json' },
    }`)
    const modulePath = (relative: string): string => JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)))
    const channel = new URL('../../src/execution/channel.ts', import.meta.url).href
    await writeFile(path.join(root, 'timeout.test.ts'), `
      import { once } from 'node:events';
      import { access, writeFile } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      import { pathToFileURL } from 'node:url';
      import { it } from 'vitest';
      import { testResources } from ${modulePath('./test-resources.ts')};
      import { startWorker } from ${modulePath('../../src/execution/worker-process.ts')};
      it('intentional failure', async (ctx) => {
        const resources = await testResources(ctx.signal, 'matrix-timed-out-worker-');
        if (${JSON.stringify(failure)} === 'early cancellation') {
          await writeFile('acquired', 'yes');
          await new Promise(() => {});
        }
        await writeFile('fixture-root', resources.root);
        if (${JSON.stringify(failure)} === 'cleanup failure') {
          await resources.acquire(() => ({}), async () => { throw new Error('forced release failure'); });
        }
        const file = resources.root + '/worker.mjs';
        await writeFile(file, ${JSON.stringify(`
          import { connectWorkerChannel } from ${JSON.stringify(channel)};
          const channel = connectWorkerChannel();
          channel.on('message', () => channel.send(process.pid));
        `)});
        const worker = await resources.acquire(() => startWorker(pathToFileURL(file), resources.root, process.env), async worker => {
          await delay(50);
          await access(resources.root);
          await worker.dispose();
          await writeFile('drained', 'yes');
        });
        const reply = once(worker.messages, 'message');
        worker.messages.send('ready');
        const [pid] = await reply;
        await writeFile('receipt.json', JSON.stringify({ pid, root: resources.root }));
        if (${JSON.stringify(failure)} === 'cleanup failure') throw new Error('original assertion failure');
        // Deliberately never enter a finally or call dispose from the test body.
        await new Promise(() => {});
      }, 5000);
    `)
    const child = await resources.acquire(() => startProcess({
      file: process.execPath,
      args: [fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', '--config', 'vitest.config.mjs'],
    }, root, { ...process.env, TMPDIR: temporaryRoot, TEMP: temporaryRoot, TMP: temporaryRoot }, 'ignore'), async (child) => {
      await child.dispose()
      await rm(temporaryRoot, { recursive: true, force: true })
    })
    if (failure === 'early cancellation') {
      await resources.poll(() => access(path.join(root, 'acquired')))
      expect((await readdir(temporaryRoot)).some(name => name.startsWith('matrix-timed-out-worker-'))).toBe(true)
      await expect(access(path.join(root, 'fixture-root'))).rejects.toMatchObject({ code: 'ENOENT' })
      cancellation.abort(new Error('cancel before receipt'))
      await resources.dispose()
      await expect(access(temporaryRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    if (failure === 'outer cancellation') {
      const receipt = await resources.poll(async () => JSON.parse(await readFile(path.join(root, 'receipt.json'), 'utf8')))
      const pending = resources.wait(child.result)
      cancellation.abort(new Error('outer test timeout'))
      await expect(pending).rejects.toBe(cancellation.signal.reason)
      await resources.dispose()
      await expect(access(receipt.root)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(() => process.kill(receipt.pid, 0)).toThrow()
      return
    }
    const result = await resources.wait(child.result)
    const fixtureRoot = await readFile(path.join(root, 'fixture-root'), 'utf8')
    expect(result.exitCode).toBe(1)
    const report = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8'))
    expect(report.numFailedTests).toBe(1)
    const messages = report.testResults[0].assertionResults[0].failureMessages.join('\n')
    if (failure === 'timeout') {
      expect(messages).toContain('Test timed out in 5000ms')
      await expect(access(fixtureRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    else {
      expect(messages).toContain('original assertion failure')
      expect(messages).toContain('forced release failure')
      await access(fixtureRoot)
    }
    expect(await readFile(path.join(root, 'drained'), 'utf8')).toBe('yes')
    const receipt = JSON.parse(await readFile(path.join(root, 'receipt.json'), 'utf8'))
    expect(() => process.kill(receipt.pid, 0)).toThrow()
  })
})
