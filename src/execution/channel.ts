import type { Socket } from 'node:net'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'

/** Control traffic is separate from inherited application stdin/stdout/stderr. */
export async function createProcessChannel(): Promise<{ name: string, address: string, connected: Promise<Socket>, close: () => Promise<void> }> {
  const name = `matrix-${randomUUID()}`
  // macOS/Linux sockaddr_un has a small byte limit. A valid, long TMPDIR
  // must not prevent worker startup; /tmp is the short POSIX fallback.
  const socketName = `mx-${randomUUID()}`
  const temporaryAddress = path.join(os.tmpdir(), socketName)
  const address = process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : Buffer.byteLength(temporaryAddress) < 100 ? temporaryAddress : path.join('/tmp', socketName)
  let accept!: (socket: Socket) => void
  let reject!: (error: Error) => void
  let socket: Socket | undefined
  const connected = new Promise<Socket>((resolve, fail) => {
    accept = resolve
    reject = fail
  })
  void connected.catch(() => undefined)
  const server = net.createServer((client) => {
    if (socket) {
      client.destroy()
      return
    }
    socket = client
    accept(client)
  })
  server.on('error', reject)
  await new Promise<void>((resolve, fail) => {
    server.once('error', fail)
    server.listen(address, resolve)
  })
  let closing: Promise<void> | undefined
  return {
    name,
    address,
    connected,
    close: () => closing ??= new Promise<void>((resolve, fail) => {
      reject(new Error('Process channel closed'))
      socket?.destroy()
      server.close(error => error ? fail(error) : resolve())
    }),
  }
}

/** One JSON message protocol for host workers on both platform backends. */
export interface WorkerChannel extends EventEmitter {
  send: (message: unknown, callback?: (error: Error | null) => void) => void
  connected: boolean
}

export function sendMessage(socket: Socket, message: unknown, callback?: (error: Error | null) => void): void {
  socket.write(`${JSON.stringify(message)}\n`, error => callback?.(error ?? null))
}

export function receiveMessages(socket: Socket, events: EventEmitter): void {
  readMessages(socket, (line) => {
    try {
      events.emit('message', JSON.parse(line))
    }
    catch (error) {
      events.emit('error', error)
    }
  })
  socket.on('error', error => events.emit('error', error))
}

export function connectWorkerChannel(): WorkerChannel {
  const address = process.env.__MATRIX_WORKER_PIPE
  delete process.env.__MATRIX_WORKER_PIPE
  if (!address)
    throw new Error('Worker started without an owned message channel')
  const socket = net.connect(address)
  const channel = Object.defineProperty(Object.assign(new EventEmitter(), {
    send: (message: unknown, callback?: (error: Error | null) => void) => {
      sendMessage(socket, message, callback)
    },
  }), 'connected', { get: () => !socket.destroyed }) as WorkerChannel
  receiveMessages(socket, channel)
  socket.on('close', () => channel.emit('close'))
  return channel
}

export function readMessages(socket: Socket, receive: (line: string) => void): void {
  createInterface({ input: socket, crlfDelay: Infinity }).on('line', receive)
}
