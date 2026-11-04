import type { Duplex } from 'node:stream'
import { Buffer } from 'node:buffer'
import { createInterface } from 'node:readline'
import { duplexPair } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startWindowsJob } from '../../src/execution/windows-job.js'

const boundary = vi.hoisted(() => ({ launch: vi.fn(), channel: vi.fn() }))
vi.mock('execa', () => ({ execa: boundary.launch }))
vi.mock('../../src/execution/channel.js', async original => ({
  ...await original<typeof import('../../src/execution/channel.js')>(),
  createProcessChannel: boundary.channel,
}))

const streams: Duplex[] = []
afterEach(() => {
  for (const stream of streams.splice(0))
    stream.destroy()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.resetAllMocks()
})

function owner(
  onStop: (peer: Duplex, exit: (failed?: boolean) => void) => void,
  onRequest?: (peer: Duplex, exit: (failed?: boolean) => void) => void,
) {
  vi.stubEnv('SystemRoot', 'C:/Windows')
  const [socket, peer] = duplexPair()
  streams.push(socket, peer)
  socket.on('end', () => socket.destroy())
  const requests: Array<{ cancelled: boolean }> = []
  let exit!: (failed?: boolean) => void
  const completion = new Promise<{ failed: boolean }>((resolve) => {
    exit = (failed = false) => resolve({ failed })
  })
  boundary.channel.mockResolvedValue({ name: 'test', connected: Promise.resolve(socket), close: () => socket.destroy() })
  boundary.launch.mockImplementation(() => {
    createInterface({ input: peer }).on('line', (line) => {
      if (line === 'stop') {
        onStop(peer, exit)
        return
      }
      requests.push(JSON.parse(line))
      if (onRequest)
        onRequest(peer, exit)
      else
        peer.write('exit 0\n')
    })
    return Object.assign(completion, { kill: () => {
      peer.end()
      exit()
      return true
    } })
  })
  return { requests }
}

describe('windows owner transport', () => {
  it('consumes the final drain certificate when supervisor exit arrives before pipe data', async () => {
    owner((peer, exit) => {
      exit()
      setImmediate(() => peer.end('stopped\n'))
    })
    const process = startWindowsJob('cmd.exe', 'cmd.exe /c echo test', '.', {})
    expect(await process.result).toEqual({ exitCode: 0 })
    await expect(process.dispose()).resolves.toBeUndefined()
  })

  it('refuses release when the supervisor exits without a drain certificate', async () => {
    owner((peer, exit) => {
      exit()
      peer.end()
    })
    const process = startWindowsJob('cmd.exe', 'cmd.exe /c echo test', '.', {})
    await process.result
    await expect(process.dispose()).rejects.toThrow('without certifying')
  })

  it('cancels an owner still starting before it is permitted to launch user code', async () => {
    const { requests } = owner((peer, exit) => {
      peer.end('stopped\n')
      exit()
    })
    const process = startWindowsJob('cmd.exe', 'cmd.exe /c echo test', '.', {})
    await process.dispose()
    expect(requests).toEqual([expect.objectContaining({ cancelled: true })])
  })

  it('preserves native startup errors and does not certify release on an abnormal exit', async () => {
    owner(() => {}, (peer, exit) => {
      peer.end(`error ${Buffer.from('CreateProcess failed').toString('base64')}\n`)
      exit(true)
    })
    const process = startWindowsJob('missing.exe', 'missing.exe', '.', {})
    await expect(process.result).rejects.toThrow('CreateProcess failed')
    const disposal = process.dispose()
    expect(process.dispose()).toBe(disposal)
    await expect(disposal).rejects.toThrow('without certifying')
  })

  it('rejects a failed supervisor even after it sends a drain certificate', async () => {
    owner((peer, exit) => {
      peer.end('stopped\n')
      exit(true)
    })
    const process = startWindowsJob('cmd.exe', 'cmd.exe /c echo test', '.', {})
    await process.result
    await expect(process.dispose()).rejects.toThrow('failed after draining')
  })

  it.each([false, true])('bounds unconnected startup and stops its owner even when transport cleanup fails (%s)', async (closeFails) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubEnv('SystemRoot', 'C:/Windows')
    let exit!: () => void
    const completion = new Promise<{ failed: boolean }>((resolve) => {
      exit = () => resolve({ failed: true })
    })
    const kill = vi.fn(() => {
      exit()
      return true
    })
    const close = vi.fn(async () => {
      if (closeFails)
        throw new Error('pipe cleanup failed')
    })
    boundary.channel.mockResolvedValue({ name: 'unconnected', connected: new Promise(() => {}), close })
    boundary.launch.mockReturnValue(Object.assign(completion, { kill }))
    const process = startWindowsJob('cmd.exe', 'cmd.exe /c echo test', '.', {})
    const result = expect(process.result).rejects.toThrow('did not connect')
    const disposal = process.dispose()
    const cleanup = disposal.catch(error => error)
    expect(process.dispose()).toBe(disposal)
    await vi.waitFor(() => expect(boundary.launch).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.all([result, cleanup])
    expect((await cleanup).errors.map((error: Error) => error.message)).toEqual([
      'Windows process owner did not connect',
      'Windows process owner exited without certifying an empty job',
      ...(closeFails ? ['pipe cleanup failed'] : []),
    ])
    expect(kill).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('bounds an unresponsive owner and reports the same failure to concurrent cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    owner(() => {})
    const process = startWindowsJob('cmd.exe', 'cmd.exe /c echo test', '.', {})
    await process.result
    const disposal = process.dispose()
    const cleanup = expect(disposal).rejects.toThrow('did not certify shutdown')
    expect(process.dispose()).toBe(disposal)
    // Disposal resumes after awaiting startup, before its stop timeout is armed.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20_000)
    await cleanup
  })

  it('bounds a control pipe that stays open after supervisor exit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    owner((peer, exit) => {
      peer.write('stopped\n')
      exit()
    })
    const process = startWindowsJob('cmd.exe', 'cmd.exe /c echo test', '.', {})
    await process.result
    const disposal = process.dispose()
    const cleanup = expect(disposal).rejects.toThrow('control channel did not close')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    await cleanup
  })

  it.each(['startup', 'shutdown'])('fails closed when OS termination does not stop the owner during %s', async (phase) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubEnv('SystemRoot', 'C:/Windows')
    const [socket, peer] = duplexPair()
    streams.push(socket, peer)
    socket.on('end', () => socket.destroy())
    createInterface({ input: peer }).on('line', (line) => {
      if (line !== 'stop')
        peer.write('exit 0\n')
    })
    let exit!: () => void
    const completion = new Promise<{ failed: boolean }>((resolve) => {
      exit = () => resolve({ failed: true })
    })
    const kill = vi.fn(() => false)
    const close = vi.fn(async () => {
      socket.destroy()
    })
    boundary.channel.mockResolvedValue({
      name: 'refused-termination',
      connected: phase === 'startup' ? new Promise(() => {}) : Promise.resolve(socket),
      close,
    })
    boundary.launch.mockReturnValue(Object.assign(completion, { kill }))
    const process = startWindowsJob('cmd.exe', 'cmd.exe /c echo test', '.', {})
    const result = phase === 'startup'
      ? expect(process.result).rejects.toThrow('did not connect')
      : expect(process.result).resolves.toEqual({ exitCode: 0 })
    try {
      if (phase === 'shutdown')
        await result
      const disposal = process.dispose()
      const cleanup = expect(disposal).rejects.toThrow('did not exit after termination')
      expect(process.dispose()).toBe(disposal)
      await vi.waitFor(() => expect(boundary.launch).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(phase === 'startup' ? 35_000 : 25_000)
      await Promise.all([result, cleanup])
      expect(kill).toHaveBeenCalledOnce()
      // Timeout is a failure, not evidence of release. The exit observer keeps
      // the transport until the still-running owner actually terminates.
      expect(close).not.toHaveBeenCalled()
    }
    finally {
      peer.end()
      exit()
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    }
  })
})
