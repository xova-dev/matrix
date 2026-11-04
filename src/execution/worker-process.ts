import type { WorkerChannel } from './channel.js'
import type { OwnedProcess } from './process.js'
import { EventEmitter } from 'node:events'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { withCleanup } from '../utils/errors.js'
import { createProcessChannel, receiveMessages, sendMessage } from './channel.js'
import { startProcess } from './process.js'

export interface OwnedWorker extends OwnedProcess {
  messages: WorkerChannel
}

/** Called inside session.start: even transport creation belongs to its resource lease. */
export function startWorker(url: URL, cwd: string, env: Record<string, string>): OwnedWorker {
  let disposal: Promise<void> | undefined
  const events = new EventEmitter()
  const channel = createProcessChannel()
  const connected = channel.then(async (channel) => {
    const socket = await channel.connected
    receiveMessages(socket, events)
    return socket
  })
  void connected.catch(() => undefined)
  const messages = Object.assign(events, {
    connected: true,
    send(message: unknown, callback?: (error: Error | null) => void) {
      void connected.then(socket => sendMessage(socket, message, callback), error => callback?.(error))
    },
  })
  const started = channel.then((channel) => {
    if (disposal)
      return undefined
    return startProcess({ file: process.execPath, args: [fileURLToPath(url)] }, cwd, {
      ...env,
      __MATRIX_WORKER_PIPE: channel.address,
    }, 'ignore')
  })
  const result = started.then(child => child?.result ?? { signal: 'SIGTERM' })
  void result.then(
    result => messages.emit('close', result.exitCode),
    error => messages.emit('error', error),
  )
  return {
    result,
    messages,
    dispose: () => disposal ??= withCleanup(
      async () => (await started)?.dispose(),
      async () => {
        messages.connected = false
        await (await channel).close()
      },
    ),
  }
}
