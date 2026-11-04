import type { OwnedWorker } from '../../src/execution/worker-process.js'
import { once } from 'node:events'
import { access, mkdir, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import path from 'pathe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessChannel } from '../../src/execution/channel.js'
import { startWorker } from '../../src/execution/worker-process.js'
import { processExists } from '../helpers/process-fixture.js'
import { testResources } from '../helpers/test-resources.js'
import { processTestTimeout } from '../helpers/timeouts.js'

const channelModule = new URL('../../src/execution/channel.ts', import.meta.url).href
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))

async function reply(worker: OwnedWorker, signal: AbortSignal): Promise<any[]> {
  const controller = new AbortController()
  try {
    return await Promise.race([
      once(worker.messages, 'message', { signal: AbortSignal.any([signal, controller.signal]) }),
      worker.result.then(() => { throw new Error('Worker exited before replying') }),
    ])
  }
  finally {
    controller.abort()
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('owned worker transport', { timeout: processTestTimeout }, () => {
  it('keeps host workers from consuming the command coordinator stdin', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix-worker-')
    const { root } = resources
    const file = path.join(root, 'worker.mjs')
    await writeFile(file, `
      import { readFileSync } from 'node:fs';
      import { connectWorkerChannel } from ${JSON.stringify(channelModule)};
      const channel = connectWorkerChannel();
      channel.on('message', () => channel.send(readFileSync(0, 'utf8')));
    `)
    const loader = `
      import { registerHooks } from 'node:module';
      import { once } from 'node:events';
      import { readFileSync } from 'node:fs';
      registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
        if (e.code !== 'ERR_MODULE_NOT_FOUND' || !s.endsWith('.js')) throw e;
        return next(s.slice(0, -3) + '.ts', c);
      } } });
      const { startWorker } = await import(${JSON.stringify(new URL('../../src/execution/worker-process.ts', import.meta.url).href)});
      const worker = startWorker(new URL(${JSON.stringify(pathToFileURL(file).href)}), process.cwd(), process.env);
      worker.messages.on('error', () => {});
      try {
        const reply = once(worker.messages, 'message');
        worker.messages.send('read');
        const [input] = await reply;
        console.log(JSON.stringify({ worker: input, coordinator: readFileSync(0, 'utf8') }));
      } finally { await worker.dispose(); }
    `
    const command = await resources.acquire(() => ({ child: execa(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', loader], {
      cwd: root,
      input: 'reserved for targets',
      timeout: 25_000,
      killDescendants: true,
    }) }), async ({ child }) => {
      child.kill('SIGKILL')
      await child.catch(() => undefined)
    })
    const result = await resources.wait(command.child)
    expect(JSON.parse(result.stdout)).toEqual({ worker: '', coordinator: 'reserved for targets' })
  })

  it('uses one request/cancel protocol and awaits process and channel disposal', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix-worker-')
    const { root } = resources
    const file = path.join(root, 'worker.mjs')
    await writeFile(file, `
      import { connectWorkerChannel } from ${JSON.stringify(channelModule)};
      import { writeFileSync } from 'node:fs';
      const channel = connectWorkerChannel();
      channel.on('message', message => {
        if (message === 'cancel') {
          writeFileSync('closed', 'yes');
          channel.send('cancelled');
        } else {
          channel.send({ request: message, pid: process.pid });
        }
      });
    `)
    const worker = await resources.acquire(() => startWorker(pathToFileURL(file), root, env), worker => worker.dispose())
    worker.messages.on('error', () => {})
    const response = reply(worker, resources.signal)
    worker.messages.send({ product: 'alpha' })
    const [message] = await response
    expect(message.request).toEqual({ product: 'alpha' })
    const cancelled = reply(worker, resources.signal)
    worker.messages.send('cancel')
    await expect(cancelled).resolves.toEqual(['cancelled'])
    await access(path.join(root, 'closed'))
    const disposal = worker.dispose()
    expect(worker.dispose()).toBe(disposal)
    await disposal
    await worker.result
    expect(worker.messages.connected).toBe(false)
    expect(processExists(message.pid)).toBe(false)
  })

  it('cancels during channel creation without launching user code', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix-worker-')
    const { root } = resources
    const file = path.join(root, 'worker.mjs')
    await writeFile(file, 'import { writeFileSync } from "node:fs"; writeFileSync("ran", "yes")')
    const { worker, disposal } = await resources.acquire(() => {
      const worker = startWorker(pathToFileURL(file), root, env)
      worker.messages.on('error', () => {})
      return { worker, disposal: worker.dispose() }
    }, ({ worker }) => worker.dispose())
    await disposal
    await expect(worker.result).resolves.toEqual({ signal: 'SIGTERM' })
    await expect(access(path.join(root, 'ran'))).rejects.toThrow()
  })

  it.for(['exit', 'timeout'])('releases an unanswered worker after %s', async (failure, ctx) => {
    const cancellation = new AbortController()
    const resources = await testResources(AbortSignal.any([ctx.signal, cancellation.signal]), 'matrix-unanswered-')
    const file = path.join(resources.root, 'worker.mjs')
    await writeFile(file, `
      import { connectWorkerChannel } from ${JSON.stringify(channelModule)};
      const channel = connectWorkerChannel();
      channel.on('message', message => {
        if (message === 'ready') channel.send(process.pid);
        else if (message === 'exit') process.exit(0);
      });
    `)
    const worker = await resources.acquire(() => startWorker(pathToFileURL(file), resources.root, env), worker => worker.dispose())
    const ready = reply(worker, resources.signal)
    worker.messages.send('ready')
    const [pid] = await ready
    const unanswered = reply(worker, resources.signal)
    worker.messages.send(failure)
    if (failure === 'timeout')
      cancellation.abort(new Error('test timeout'))
    await expect(unanswered).rejects.toThrow(failure === 'exit' ? 'Worker exited before replying' : /abort/i)
    await resources.dispose()
    expect(processExists(pid)).toBe(false)
    expect(worker.messages.connected).toBe(false)
  })

  it('closes a channel with no connected worker and rejects pending delivery', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix-worker-')
    const channel = await resources.acquire(createProcessChannel, channel => channel.close())
    const connected = expect(channel.connected).rejects.toThrow('closed')
    const closed = channel.close()
    expect(channel.close()).toBe(closed)
    await closed
    await connected
    if (process.platform !== 'win32')
      await expect(access(channel.address)).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('connects and disposes with a TMPDIR longer than the Unix socket limit', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix-worker-')
    const { root } = resources
    const longDirectory = path.join(root, '临时目录'.repeat(15))
    await mkdir(longDirectory)
    vi.stubEnv('TMPDIR', longDirectory)
    const channel = await resources.acquire(createProcessChannel, channel => channel.close())
    await resources.acquire(() => net.connect(channel.address), async (client) => {
      client.destroy()
    })
    await resources.wait(channel.connected)
    await resources.dispose()
    await expect(access(channel.address)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
