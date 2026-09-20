import type { ExecutionPlan, ExecutionTask } from '../src/types.js'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runExecutionPlan } from '../src/exec.js'

function task(id: string, command: string, overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    id,
    product: 'app',
    variant: id.split(':')[1] ?? id,
    project: 'project',
    projectRoot: process.cwd(),
    target: 'test',
    name: id,
    slug: id,
    command,
    cwd: process.cwd(),
    env: {},
    continuous: false,
    archive: { enabled: false, format: 'zip' },
    outputDir: process.cwd(),
    dependsOn: [],
    ...overrides,
  }
}

const scriptCommand = [process.execPath, '--eval=eval(Buffer.from(process.env.MATRIX_TEST_SCRIPT,String.fromCharCode(98,97,115,101,54,52)).toString())'].join(' ')

function scriptedTask(id: string, script: string, overrides: Partial<ExecutionTask> = {}): ExecutionTask {
  return task(id, scriptCommand, {
    ...overrides,
    env: {
      MATRIX_TEST_SCRIPT: Buffer.from(script).toString('base64'),
      ...overrides.env,
    },
  })
}

function plan(tasks: ExecutionTask[]): ExecutionPlan {
  return { envName: 'development', tasks, artifactsRoot: process.cwd() }
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Failed to allocate a test port')
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  return port
}

describe('runExecutionPlan', () => {
  it('waits for completed dependencies before starting the dependent task', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-exec-'))
    const marker = path.join(cwd, 'marker')
    const dependency = scriptedTask('app:dependency:test', [
      'const fs = require("node:fs")',
      'setTimeout(() => fs.appendFileSync(process.env.MATRIX_TEST_MARKER, "dependency" + String.fromCharCode(10)), 50)',
    ].join(String.fromCharCode(10)), { env: { MATRIX_TEST_MARKER: marker } })
    const dependent = scriptedTask('app:dependent:test', [
      'require("node:fs").appendFileSync(process.env.MATRIX_TEST_MARKER, "dependent" + String.fromCharCode(10))',
    ].join(String.fromCharCode(10)), {
      env: { MATRIX_TEST_MARKER: marker },
      dependsOn: [{ id: dependency.id, condition: 'completed' }],
    })

    await runExecutionPlan(plan([dependency, dependent]))

    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('dependency\ndependent\n')
  })

  it('does not start dependents when a completed dependency fails', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-exec-'))
    const marker = path.join(cwd, 'marker')
    const dependency = scriptedTask('app:dependency:test', 'process.exit(7)')
    const dependent = scriptedTask('app:dependent:test', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "started")', {
      env: { MATRIX_TEST_MARKER: marker },
      dependsOn: [{ id: dependency.id, condition: 'completed' }],
    })

    await expect(runExecutionPlan(plan([dependency, dependent])))
      .rejects
      .toThrow('app:dependency:test exited with code 7')
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits for a port before starting a ready dependent', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-exec-'))
    const marker = path.join(cwd, 'marker')
    const port = await freePort()
    const service = scriptedTask('app:service:test', [
      'const net = require("node:net")',
      'const server = net.createServer()',
      'server.listen(Number(process.env.MATRIX_TEST_PORT), "127.0.0.1")',
      'setTimeout(() => server.close(() => process.exit(0)), 350)',
    ].join(String.fromCharCode(10)), {
      continuous: true,
      env: { MATRIX_TEST_PORT: port },
      readyWhen: { type: 'port', host: '127.0.0.1', port, timeout: 2_000 },
    })
    const dependent = scriptedTask('app:dependent:test', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "started")', {
      env: { MATRIX_TEST_MARKER: marker },
      dependsOn: [{ id: service.id, condition: 'ready' }],
    })

    await runExecutionPlan(plan([service, dependent]))

    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('started')
  })

  it('fails when a ready dependency exits before becoming ready', async () => {
    const port = await freePort()
    const service = scriptedTask('app:service:test', 'setTimeout(() => process.exit(0), 150)', {
      continuous: true,
      readyWhen: { type: 'port', host: '127.0.0.1', port, timeout: 2_000 },
    })
    const dependent = scriptedTask('app:dependent:test', 'process.exit(0)', {
      dependsOn: [{ id: service.id, condition: 'ready' }],
    })

    await expect(runExecutionPlan(plan([service, dependent])))
      .rejects
      .toThrow('app:service:test exited before becoming ready')
  })
})
