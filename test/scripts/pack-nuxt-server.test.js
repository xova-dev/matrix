import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execa } from 'execa'
import { afterEach, expect, it, vi } from 'vitest'
import { withServer } from '../../scripts/pack-nuxt.mjs'

const { taskkillCommand } = vi.hoisted(() => ({ taskkillCommand: vi.fn() }))
vi.mock('execa', async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    execa: (command, ...args) => taskkillCommand.getMockImplementation() && /(?:^|[/\\])taskkill\.exe$/i.test(command)
      ? taskkillCommand(command, ...args)
      : original.execa(command, ...args),
  }
})

const directories = []
const hostPlatform = process.platform
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
  taskkillCommand.mockReset()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function service(mode = 'normal', verify = async () => {}, limits = deadlines) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-server-'))
  directories.push(cwd)
  await writeFile(path.join(cwd, 'service.mjs'), fixture)
  const messages = []
  vi.spyOn(console, 'log').mockImplementation(message => messages.push(message))
  const operation = withServer(process.execPath, ['service.mjs'], {
    cwd,
    label: 'fixture service',
    env: { SERVICE_MODE: mode },
  }, verify, limits)
  return { cwd, messages, operation }
}

async function assertExited(cwd, names = ['root']) {
  for (const name of names) {
    const pid = Number(await readFile(path.join(cwd, `${name}.pid`), 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  }
}

async function forceFixtureExit(cwd) {
  const pid = Number(await readFile(path.join(cwd, 'root.pid'), 'utf8'))
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
  }
  catch (error) {
    if (error.code !== 'ESRCH')
      throw error
  }
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
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
  let kill
  const denied = Object.assign(new Error('fixture cleanup denied'), { code: 'EPERM' })
  const { cwd, operation } = await service('stubborn', async (_page, request) => {
    kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw denied
    })
    await request('/body')
  })
  try {
    const error = await operation.catch(error => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors.some(error => error.message.includes('HTTP /body'))).toBe(true)
    expect(error.errors.some(error => error.message.includes('shutdown failed') && error.cause === denied)).toBe(true)
    expect(error.errors.some(error => error.message.includes('forced cleanup failed') && error.cause === denied)).toBe(true)
  }
  finally {
    kill?.mockRestore()
    await forceFixtureExit(cwd)
  }
})

it.each([false, true])('retains a failed Windows tree command after its root disappears (verification failed: %s)', async (verificationFailed) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const original = new Error('original HTTP verification failure')
  const teardown = await execa(process.execPath, ['-e', 'process.stderr.write("TASKKILL_STDERR_SENTINEL"); process.exit(9)'], { reject: false })
  expect(teardown.failed).toBe(true)
  expect(teardown).toBeInstanceOf(Error)
  taskkillCommand.mockImplementation(async (_command, args) => {
    const pid = Number(args[args.indexOf('/PID') + 1])
    try {
      process.kill(hostPlatform === 'win32' ? pid : -pid, 'SIGKILL')
    }
    catch (error) {
      if (error.code !== 'ESRCH')
        throw error
    }
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
    return teardown
  })
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  const { cwd, messages, operation } = await service('normal', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    if (verificationFailed)
      throw original
  })
  try {
    const error = await operation.catch(error => error)
    const failures = error instanceof AggregateError ? error.errors : [error]
    expect(taskkillCommand).toHaveBeenCalled()
    const shutdown = failures.find(error => error?.message.includes('shutdown failed'))
    expect(shutdown).toBeInstanceOf(Error)
    expect(shutdown?.message).toContain(teardown.shortMessage)
    expect(shutdown?.message).toContain('TASKKILL_STDERR_SENTINEL')
    expect(shutdown?.cause.cause).toBe(teardown)
    expect(messages.some(message => message.includes('shutdown passed'))).toBe(false)
    if (verificationFailed) {
      expect(error).toBeInstanceOf(AggregateError)
      expect(failures.some(error => error.cause === original)).toBe(true)
    }
    await assertExited(cwd)
  }
  finally {
    Object.defineProperty(process, 'platform', platform)
    await forceFixtureExit(cwd)
  }
})
