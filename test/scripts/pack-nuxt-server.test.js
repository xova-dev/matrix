import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execa } from 'execa'
import { afterEach, expect, it, vi } from 'vitest'
import { verifyShutdown, withTimeout } from '../../scripts/pack-cli.mjs'
import { terminateWindowsTree, withServer } from '../../scripts/pack-nuxt.mjs'
import { createPackageTimings } from '../../scripts/pack-timings.mjs'
import { temporaryDirectory } from '../helpers/temporary-directory.js'

const processes = []
const deadlines = { startup: 3000, verification: 2000, request: 200, shutdown: 2000, cleanup: 2000 }
const fixture = `
  import { spawn } from 'node:child_process'
  import { writeFileSync } from 'node:fs'
  import { createServer } from 'node:http'
  const mode = process.env.SERVICE_MODE
  writeFileSync('root.pid', String(process.pid))
  if (mode === 'noisy') {
    console.error('DISCARDED_PREFIX' + 'x'.repeat(65536))
    console.error('RETAINED_SERVICE_DIAGNOSTIC')
  }
  const server = createServer((request, response) => {
    writeFileSync('requested', request.url)
    if (mode === 'startup') return
    if (request.url === '/headers') return
    if (request.url === '/body') {
      response.writeHead(200)
      response.write('partial')
      return
    }
    response.end('ready')
  })
  process.on('SIGTERM', () => {
    if (mode === 'stubborn') return
    if (mode === 'bad-exit') process.exit(7)
    if (mode === 'term-code') process.exit(143)
    writeFileSync('closed', 'yes')
    server.closeAllConnections()
    server.close(() => process.exit(0))
  })
  if (mode === 'descendant') {
    const child = spawn(process.execPath, ['--input-type=module', '-e', \`
      import { writeFileSync } from 'node:fs'
      process.on('SIGTERM', () => {})
      writeFileSync('descendant.pid', String(process.pid))
      process.send('ready')
      setInterval(() => {}, 1000)
    \`], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child.once('message', () => server.listen(Number(process.env.PORT), '127.0.0.1'))
    process.on('SIGTERM', () => process.exit(0))
  } else {
    server.listen(Number(process.env.PORT), '127.0.0.1')
  }
`

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const failures = []
  for (const owned of processes.splice(0)) {
    try {
      if (!owned.closed)
        owned.child.kill('SIGKILL')
    }
    catch (error) {
      failures.push(error)
    }
    try {
      await withTimeout(owned.completion, 3000, `Fixture process ${owned.child.pid} did not close`)
    }
    catch (error) {
      failures.push(error)
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Fixture process cleanup failed')
})

function startProcess(...args) {
  const child = execa(...args)
  const owned = { child, completion: child.catch(error => error), closed: false }
  void owned.completion.then(() => owned.closed = true)
  processes.push(owned)
  return child
}

async function service(mode = 'normal', verify = async () => {}, limits = deadlines) {
  const cwd = await temporaryDirectory('matrix-server-')
  await writeFile(path.join(cwd, 'service.mjs'), fixture)
  const messages = []
  vi.spyOn(console, 'log').mockImplementation(message => messages.push(message))
  const operation = withServer(process.execPath, ['service.mjs'], {
    cwd,
    label: 'fixture service',
    env: { SERVICE_MODE: mode },
    timing: { timings: createPackageTimings(), consumer: 'fixture', phase: 'service' },
  }, verify, limits, startProcess)
  return { cwd, messages, operation }
}

async function assertExited(cwd, names = ['root']) {
  for (const name of names) {
    const pid = Number(await readFile(path.join(cwd, `${name}.pid`), 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  }
}

it('verifies a real HTTP service and finishes its owned teardown before returning', async () => {
  const { cwd, messages, operation } = await service('normal', async ({ body }, request) => {
    expect(body).toBe('ready')
    expect((await request('/next')).body).toBe('ready')
  })
  await operation
  await assertExited(cwd)
  for (const phase of ['startup', 'verification', 'shutdown'])
    expect(messages.some(message => message.includes(`${phase} passed`))).toBe(true)
  const wallTimings = messages.filter(message => message.startsWith('Package wall timing:'))
  expect(wallTimings).toHaveLength(4)
  expect(wallTimings.at(-1)).toMatch(/fixture service-total \d+\.\ds \(passed\)/)
  expect(messages.indexOf(wallTimings.at(-1))).toBeGreaterThan(messages.findIndex(message => message.includes('shutdown passed')))
  if (process.platform === 'win32')
    expect(messages.some(message => message.includes('taskkill /T /F (not graceful cancellation)'))).toBe(true)
  else
    expect(await readFile(path.join(cwd, 'closed'), 'utf8')).toBe('yes')
})

it('bounds readiness HTTP waits without entering verification', async () => {
  let verified = false
  const { cwd, operation } = await service('startup', async () => verified = true, { ...deadlines, startup: 1500 })
  await expect(operation).rejects.toThrow('startup timed out after 1500ms')
  expect(await readFile(path.join(cwd, 'requested'), 'utf8')).toBe('/')
  expect(verified).toBe(false)
  await assertExited(cwd)
})

it.each(['/headers', '/body'])('bounds request and body waits at %s and does not turn cleanup into success', async (resource) => {
  const { cwd, operation } = await service('stubborn', async (_page, request) => {
    await request(resource)
  })
  const started = performance.now()
  const error = await operation.catch(error => error)
  const failures = error instanceof AggregateError ? error.errors : [error]
  expect(failures.some(error => error.message.includes(`HTTP ${resource}`) && error.message.includes('request/body deadline'))).toBe(true)
  if (process.platform !== 'win32')
    expect(failures.some(error => error.message.includes('shutdown timed out'))).toBe(true)
  expect(performance.now() - started).toBeLessThan(6000)
  await assertExited(cwd)
})

it('bounds inherited descendant pipes without accepting a failed POSIX shutdown', async () => {
  const { cwd, messages, operation } = await service('descendant')
  if (process.platform === 'win32') {
    await operation
    expect(messages.some(message => message.includes('taskkill /T /F (not graceful cancellation)'))).toBe(true)
  }
  else {
    await expect(operation).rejects.toThrow('shutdown timed out')
    expect(messages.some(message => message.includes('forced cleanup passed'))).toBe(true)
  }
  await assertExited(cwd, ['root', 'descendant'])
})

it('keeps the original verification failure and only a bounded raw service-output tail', async () => {
  const original = new Error('original verification failure')
  const { cwd, operation } = await service('noisy', async () => {
    throw original
  })
  const error = await operation.catch(error => error)
  expect(error.cause).toBe(original)
  expect(error.message).toContain('original verification failure')
  expect(error.message).toContain('RETAINED_SERVICE_DIAGNOSTIC')
  expect(error.message).not.toContain('DISCARDED_PREFIX')
  expect(error.message.length).toBeLessThan(17_000)
  await assertExited(cwd)
})

it.skipIf(process.platform === 'win32')('does not accept an unsuccessful service exit during POSIX teardown', async () => {
  const { cwd, messages, operation } = await service('bad-exit')
  await expect(operation).rejects.toThrow('Service exited unsuccessfully during teardown (7)')
  expect(messages.some(message => message.includes('forced cleanup passed'))).toBe(true)
  await assertExited(cwd)
})

it.skipIf(process.platform === 'win32')('accepts the conventional exit code for its requested POSIX SIGTERM', async () => {
  const { cwd, messages, operation } = await service('term-code')
  await operation
  expect(messages.some(message => message.includes('shutdown passed'))).toBe(true)
  expect(messages.some(message => message.includes('forced cleanup'))).toBe(false)
  await assertExited(cwd)
})

it('retains verification and teardown errors when the OS refuses cleanup', async () => {
  const denied = Object.assign(new Error('fixture cleanup denied'), { code: 'EPERM' })
  const { messages, operation } = await service('stubborn', async (_page, request) => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw denied
    })
    await request('/body')
  })
  const error = await operation.catch(error => error)
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors.some(error => error.message.includes('HTTP /body'))).toBe(true)
  expect(error.errors.some(error => error.message.includes('shutdown failed') && error.cause === denied)).toBe(true)
  expect(error.errors.some(error => error.message.includes('forced cleanup failed') && error.cause === denied)).toBe(true)
  const wallTimings = messages.filter(message => message.startsWith('Package wall timing:'))
  expect(wallTimings.at(-2)).toMatch(/fixture service-forced-cleanup \d+\.\ds \(failed\)/)
  expect(wallTimings.at(-1)).toMatch(/fixture service-total \d+\.\ds \(failed\)/)
})

it('retains a failed Windows tree command after its real root process has closed', async () => {
  const cwd = await temporaryDirectory('matrix-tree-command-')
  const teardown = await execa(process.execPath, ['-e', 'process.stderr.write("TASKKILL_STDERR_SENTINEL"); process.exit(9)'], { reject: false })
  expect(teardown.failed).toBe(true)
  expect(teardown).toBeInstanceOf(Error)
  const child = startProcess(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
    cwd,
    killDescendants: true,
  })
  await withTimeout(once(child.nodeChildProcess.stdout, 'data'), 3000, 'Tree-command fixture did not become ready')
  const taskkillCommand = vi.fn(async () => {
    child.kill('SIGKILL')
    await withTimeout(child.catch(error => error), 3000, 'Tree-command fixture did not close')
    expect(() => process.kill(child.pid, 0)).toThrow()
    return teardown
  })
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  const error = await terminateWindowsTree(child.pid, new AbortController().signal, 2000, taskkillCommand).catch(error => error)
  expect(taskkillCommand).toHaveBeenCalledOnce()
  expect(error.message).toContain(teardown.shortMessage)
  expect(error.message).toContain('TASKKILL_STDERR_SENTINEL')
  expect(error.cause).toBe(teardown)
})

it.skipIf(process.platform === 'win32')('retains POSIX CLI verification and cleanup errors and removes cancellation listeners', async () => {
  const root = await temporaryDirectory('matrix-cli-cleanup-')
  const cli = path.join(root, 'cli.mjs')
  await writeFile(cli, `
    import { writeFileSync } from 'node:fs'
    process.on('SIGINT', () => process.exit(7))
    setInterval(() => {}, 1000)
    for (const name of ['first', 'second']) writeFileSync(name + '.pid', String(process.pid))
  `)
  const listeners = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))
  const denied = Object.assign(new Error('fixture process-group cleanup denied'), { code: 'EPERM' })
  const kill = process.kill.bind(process)
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid < 0)
      throw denied
    return kill(pid, signal)
  })
  const error = await verifyShutdown(cli, path.join(root, 'workspace')).catch(error => error)
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors.some(error => error.message.includes('did not exit with code 130 after SIGINT'))).toBe(true)
  expect(error.errors).toContain(denied)
  expect(error.cause).toBe(error.errors[0])
  expect(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal))).toEqual(listeners)
})
