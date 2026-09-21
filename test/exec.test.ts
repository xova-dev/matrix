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
    artifacts: { mode: 'none', format: 'zip', clean: false },
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
  return { envName: 'development', tasks, artifactsRoot: process.cwd(), artifactRetention: 5 }
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
  it('cleans stale output before execution and keeps the current archived output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-exec-artifact-'))
    const output = path.join(root, 'dist')
    const artifactsRoot = path.join(root, 'artifacts')
    const freshOutput = path.join(output, 'index.html')
    const staleOutput = path.join(output, 'stale.txt')
    await fs.mkdir(output)
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
    await fs.writeFile(staleOutput, 'stale')
    const build = scriptedTask('app:web:build', 'require("node:fs").writeFileSync(process.env.MATRIX_TEST_MARKER, "fresh")', {
      cwd: root,
      projectRoot: root,
      outputDir: output,
      env: { MATRIX_TEST_MARKER: freshOutput },
      artifacts: { mode: 'archive', format: 'zip', clean: true },
    })

    await runExecutionPlan({ ...plan([build]), artifactsRoot })

    await expect(fs.stat(staleOutput)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(freshOutput, 'utf8')).resolves.toBe('fresh')
    await expect(fs.readdir(path.join(artifactsRoot, 'app', 'development'))).resolves.toHaveLength(1)
  })

  it('inherits the host environment and lets task variables override it', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-exec-'))
    const marker = path.join(cwd, 'env.json')
    const inheritedKey = 'MATRIX_TEST_HOST_INHERITED'
    const overriddenKey = 'MATRIX_TEST_HOST_OVERRIDDEN'
    const previousInherited = process.env[inheritedKey]
    const previousOverridden = process.env[overriddenKey]
    process.env[inheritedKey] = 'host-value'
    process.env[overriddenKey] = 'host-value'
    try {
      const task = scriptedTask('app:environment:test', [
        'const fs = require("node:fs")',
        `fs.writeFileSync(process.env.MATRIX_TEST_MARKER, JSON.stringify({ inherited: process.env.${inheritedKey}, overridden: process.env.${overriddenKey} }))`,
      ].join(String.fromCharCode(10)), {
        env: {
          MATRIX_TEST_MARKER: marker,
          [overriddenKey]: 'task-value',
        },
      })

      await runExecutionPlan(plan([task]))

      await expect(fs.readFile(marker, 'utf8')).resolves.toBe(JSON.stringify({ inherited: 'host-value', overridden: 'task-value' }))
    }
    finally {
      if (previousInherited === undefined)
        delete process.env[inheritedKey]
      else
        process.env[inheritedKey] = previousInherited
      if (previousOverridden === undefined)
        delete process.env[overriddenKey]
      else
        process.env[overriddenKey] = previousOverridden
    }
  })

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

  it('honors a short readiness timeout', async () => {
    const port = await freePort()
    const service = scriptedTask('app:service:test', 'setTimeout(() => process.exit(0), 500)', {
      continuous: true,
      readyWhen: { type: 'port', host: '127.0.0.1', port, timeout: 25 },
    })
    const dependent = scriptedTask('app:dependent:test', 'process.exit(0)', {
      dependsOn: [{ id: service.id, condition: 'ready' }],
    })
    const started = Date.now()

    await expect(runExecutionPlan(plan([service, dependent])))
      .rejects
      .toThrow('Timed out waiting for')
    expect(Date.now() - started).toBeLessThan(150)
  })

  it('fails fast when an independent continuous task exits unexpectedly', async () => {
    const service = scriptedTask('app:service:test', 'setTimeout(() => process.exit(9), 50)', {
      continuous: true,
    })
    const longRunningTask = scriptedTask('app:long-running:test', 'setTimeout(() => process.exit(0), 5_000)')
    const started = Date.now()

    await expect(runExecutionPlan(plan([service, longRunningTask])))
      .rejects
      .toThrow('app:service:test exited with code 9')
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
