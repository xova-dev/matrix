import type { OwnedProcess, ProcessResult } from './process.js'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { execa } from 'execa'
import path from 'pathe'
import { withCleanup } from '../utils/errors.js'
import { createProcessChannel, readMessages } from './channel.js'
import { windowsJobScript } from './windows-job-script.js'

/** Quote one Windows executable argument (shell command bodies are passed verbatim). */
export function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}

function within<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds)
    }),
  ]).finally(() => clearTimeout(timeout))
}

async function terminateOwner(owner: { kill: (signal: 'SIGKILL') => boolean }, closed: Promise<void>): Promise<void> {
  owner.kill('SIGKILL')
  // A failed OS termination request cannot turn cancellation into an unbounded
  // wait. The existing closed observer still owns eventual transport cleanup.
  await within(closed, 5_000, 'Windows process owner did not exit after termination')
}

/** The root result and the lifetime of its kernel-owned descendants are separate. */
export function startWindowsJob(application: string, command: string, cwd: string, env: Record<string, string | undefined>, stdin: 'inherit' | 'ignore' = 'inherit'): OwnedProcess {
  let stopping = false
  let resolveResult!: (result: ProcessResult) => void
  let rejectResult!: (error: unknown) => void
  const result = new Promise<ProcessResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const started = (async () => {
    const systemRoot = process.env.SystemRoot ?? process.env.windir
    if (!systemRoot || !path.win32.isAbsolute(systemRoot))
      throw new Error('Cannot own Windows processes without a Windows system directory')
    let channel: Awaited<ReturnType<typeof createProcessChannel>> | undefined
    let supervisor: (Promise<unknown> & { kill: (signal: 'SIGKILL') => boolean }) | undefined
    let closed: Promise<void> | undefined
    try {
      channel = await createProcessChannel()
      // Keep the helper process-scoped: a killed coordinator cannot leave an
      // owner.ps1 directory behind. Only the control pipe needs explicit release.
      const script = Buffer.from(`& {${windowsJobScript}\n} '${channel.name.replaceAll('\'', '\'\'')}'`, 'utf16le').toString('base64')
      const owner = execa(path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        script,
      ], { cwd, env, extendEnv: false, stdin, stdout: 'inherit', stderr: 'inherit', reject: false, windowsHide: true })
      supervisor = owner
      let certified = false
      let controlClosed: Promise<void> | undefined
      closed = withCleanup(async () => {
        const result = await owner
        // Process exit and pipe data arrive on independent OS handles. Consume
        // the final acknowledgement before judging the supervisor's exit.
        if (controlClosed)
          await within(controlClosed, 5_000, 'Windows owner control channel did not close')
        if (!certified)
          throw new Error('Windows process owner exited without certifying an empty job')
        if (result.failed)
          throw new Error('Windows process owner failed after draining its job')
      }, () => channel?.close())
      void closed.catch((error) => {
        rejectResult(error)
      })
      const socket = await within(Promise.race([
        channel.connected,
        closed.then(() => { throw new Error('Windows process owner exited before connecting') }),
      ]), 30_000, 'Windows process owner did not connect')
      controlClosed = new Promise<void>((resolve) => {
        socket.once('close', resolve)
      })
      socket.on('error', (error) => {
        rejectResult(error)
      })
      readMessages(socket, (line) => {
        if (line.startsWith('exit ')) {
          resolveResult({ exitCode: Number(line.slice(5)) })
        }
        else if (line === 'stopped') {
          certified = true
          resolveResult({ signal: 'SIGTERM' })
        }
        else if (line.startsWith('error ')) {
          const error = new Error(Buffer.from(line.slice(6), 'base64').toString('utf8'))
          rejectResult(error)
        }
      })
      socket.write(`${JSON.stringify({ application, command, cwd, cancelled: stopping })}\n`)
      return { socket, closed, owner }
    }
    catch (error) {
      // Startup owns its failure. Teardown must not race it with a secondary
      // "missing certificate" error or skip stopping the owner on a pipe error.
      rejectResult(error)
      return withCleanup(() => {
        throw error
      }, async () => {
        if (supervisor && closed)
          await terminateOwner(supervisor, closed)
        else
          await channel?.close()
      })
    }
  })()
  void started.catch((error) => {
    rejectResult(error)
  })
  let cleanup: Promise<void> | undefined
  return {
    result,
    dispose: () => cleanup ??= (async () => {
      stopping = true
      const { socket, closed, owner } = await started
      socket.write('stop\n')
      // A failed owner cannot certify release; session retains its workspace lock.
      try {
        await within(closed, 20_000, 'Windows process owner did not certify shutdown')
      }
      catch (error) {
        await withCleanup(() => {
          throw error
        }, () => terminateOwner(owner, closed))
      }
    })(),
  }
}
