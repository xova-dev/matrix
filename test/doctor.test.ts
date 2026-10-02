import type { EnvMap, MatrixConfig } from '../src/types.js'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeMatrixConfig } from '../src/config.js'
import { diagnoseWorkspace } from '../src/doctor.js'
import { runExecutionPlan } from '../src/exec.js'
import { createExecutionPlan } from '../src/plan.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-doctor-'))
  directories.push(cwd)
  return cwd
}

function input(raw: MatrixConfig, cwd: string, externalEnv: EnvMap = {}) {
  return { ...normalizeMatrixConfig(raw), cwd, envName: 'development', externalEnv }
}

describe('static doctor', () => {
  it('aggregates project and cleanup errors without changing files', async () => {
    const cwd = await workspace()
    await writeFile(path.join(cwd, 'not-a-directory'), 'keep')
    await mkdir(path.join(cwd, 'project'))
    const before = await readdir(cwd, { recursive: true })
    const raw: MatrixConfig = {
      projects: {
        missing: { root: 'missing', targets: {} },
        file: { root: 'not-a-directory', targets: {} },
        app: { root: 'project', prepare: 'must-not-run', targets: {
          root: { command: 'must-not-run', outputDir: '.', artifacts: {} },
          parent: { command: 'must-not-run', outputDir: '..', artifacts: {} },
          filesystem: { command: 'must-not-run', outputDir: path.parse(cwd).root, artifacts: {} },
        } },
      },
      products: { app: { version: '1.2.3', variants: { desktop: 'app' } } },
    }
    const diagnostics = await diagnoseWorkspace(input(raw, cwd))
    expect(diagnostics).toEqual([
      expect.objectContaining({ subject: 'missing', path: 'projects.missing.root', message: expect.stringContaining('missing') }),
      expect.objectContaining({ subject: 'file', path: 'projects.file.root', message: expect.stringContaining('not a directory') }),
      ...['root', 'parent', 'filesystem'].map(target => expect.objectContaining({
        severity: 'error',
        subject: `app:desktop:${target}`,
        path: `projects.app.targets.${target}.outputDir`,
        message: expect.stringContaining('cleanup'),
        suggestion: expect.stringContaining('outputDir'),
      })),
    ])
    expect(await readdir(cwd, { recursive: true })).toEqual(before)
    expect(await readFile(path.join(cwd, 'not-a-directory'), 'utf8')).toBe('keep')
  })

  it('reuses effective version rules and accepts missing or shared serial output directories', async () => {
    const cwd = await workspace()
    // A directory cannot be read as a package manifest on supported platforms.
    await mkdir(path.join(cwd, 'package.json'))
    const raw: MatrixConfig = {
      projects: { app: { targets: { build: { command: 'must-not-run', artifacts: {} } } } },
      products: { app: { variants: { first: 'app', second: 'app' } } },
    }
    expect(await diagnoseWorkspace(input(raw, cwd))).toEqual(['first', 'second'].map(variant => expect.objectContaining({
      severity: 'error',
      subject: `app:${variant}:build`,
      path: `${path.join(cwd, 'package.json')}#version`,
      message: expect.stringContaining('Unable to read package version'),
      suggestion: expect.stringContaining('readable package.json'),
    })))
    raw.products.app!.version = '1.2.3'
    expect(await diagnoseWorkspace(input(raw, cwd))).toEqual([])
    await mkdir(path.join(cwd, 'dist'))
    await writeFile(path.join(cwd, 'dist/keep'), 'keep')
    expect(await diagnoseWorkspace(input(raw, cwd))).toEqual([])
    expect(await readFile(path.join(cwd, 'dist/keep'), 'utf8')).toBe('keep')
  })

  it('reports dependency warnings using effective conditions and overridden readiness probes', async () => {
    const cwd = await workspace()
    const raw: MatrixConfig = {
      projects: { app: { targets: { dev: 'must-not-run' } } },
      products: { app: { variants: {
        service: 'app',
        probed: { project: 'app', targets: { dev: { readyWhen: { type: 'port', port: 49152 } } } },
        consumer: { project: 'app', targets: { dev: { dependsOn: [
          { variant: 'service', condition: 'completed' },
          'service',
          'probed',
        ] } } },
      } } },
    }
    const diagnostics = await diagnoseWorkspace(input(raw, cwd))
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', subject: 'app:consumer:dev', path: 'products.app.variants.consumer.targets.dev.dependsOn[0]', message: expect.stringContaining('continuous task app:service:dev') }),
      expect.objectContaining({ severity: 'warning', subject: 'app:consumer:dev', path: 'products.app.variants.consumer.targets.dev.dependsOn[1]', message: expect.stringContaining('no readiness probe') }),
    ])
  })

  it('preserves graph validation and aggregates independent failures without exposing env values', async () => {
    const cwd = await workspace()
    const raw: MatrixConfig = {
      envSchema: { PRIVATE_COUNT: { type: 'number' } },
      projects: { app: { targets: { build: 'must-not-run' } } },
      products: { app: { variants: {
        consumer: { project: 'app', targets: { build: { dependsOn: ['cycle'] } } },
        cycle: { project: 'app', targets: { build: { dependsOn: ['other'] } } },
        other: { project: 'app', targets: { build: { dependsOn: ['cycle'] } } },
        missing: { project: 'app', targets: { build: { dependsOn: ['absent'] } } },
        env: 'app',
      } } },
    }
    const diagnostics = await diagnoseWorkspace(input(raw, cwd, { PRIVATE_COUNT: 'private-invalid-marker' }))
    expect(diagnostics).toHaveLength(3)
    expect(diagnostics.filter(item => item.message.startsWith('Dependency cycle'))).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: 'Dependency cycle detected: app:cycle:build -> app:other:build -> app:cycle:build',
        blockedTasks: ['app:consumer:build'],
      }),
    ])
    expect(diagnostics.map(item => item.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('Dependency cycle'),
      expect.stringContaining('Unknown dependency variant'),
      expect.stringContaining('PRIVATE_COUNT: expected number'),
    ]))
    expect(JSON.stringify(diagnostics)).not.toContain('private-invalid-marker')
  })

  it('attributes inherited dependency failures to their source and lists blocked consumers once', async () => {
    const cwd = await workspace()
    const raw: MatrixConfig = {
      projects: { app: { targets: { build: { command: 'must-not-run', dependsOn: ['absent'] } } } },
      products: { app: { variants: {
        consumer: { project: 'app', targets: { build: { dependsOn: ['service'] } } },
        service: 'app',
        other: { project: 'app', targets: { build: { dependsOn: ['service'] } } },
      } } },
    }
    expect(await diagnoseWorkspace(input(raw, cwd))).toEqual([
      expect.objectContaining({
        severity: 'error',
        subject: 'app:service:build',
        path: 'projects.app.targets.build.dependsOn[0]',
        message: 'Unknown dependency variant app/absent',
        suggestion: expect.stringContaining('Correct dependsOn'),
        blockedTasks: ['app:consumer:build', 'app:other:build'],
      }),
    ])
    // An explicit variant override must be attributed to the variant instead.
    raw.products.app!.variants.service = { project: 'app', targets: { build: { dependsOn: ['other-absent'] } } }
    expect(await diagnoseWorkspace(input(raw, cwd))).toEqual([
      expect.objectContaining({
        subject: 'app:service:build',
        path: 'products.app.variants.service.targets.build.dependsOn[0]',
        message: 'Unknown dependency variant app/other-absent',
        blockedTasks: ['app:consumer:build', 'app:other:build'],
      }),
    ])
  })

  it('shares cleanup rejection with execution and honors disabled cleanup', async () => {
    const cwd = await workspace()
    await writeFile(path.join(cwd, 'keep'), 'keep')
    const raw: MatrixConfig = {
      projects: { app: { targets: { build: { command: 'must-not-run', artifacts: {} } } } },
      products: { app: { version: '1.2.3', variants: { desktop: { project: 'app', targets: { build: { outputDir: '.' } } } } } },
    }
    const loaded = input(raw, cwd)
    expect(await diagnoseWorkspace(loaded)).toEqual([
      expect.objectContaining({ severity: 'error', path: 'products.app.variants.desktop.targets.build.outputDir' }),
    ])
    await expect(runExecutionPlan(createExecutionPlan({ ...loaded, productNames: ['app'], target: 'build' }))).rejects.toThrow('Refusing to clean an unsafe output directory')
    expect(await readFile(path.join(cwd, 'keep'), 'utf8')).toBe('keep')
    raw.projects.app!.targets.build = { command: 'must-not-run', artifacts: { clean: false } }
    expect(await diagnoseWorkspace(input(raw, cwd))).toEqual([])
  })
})
