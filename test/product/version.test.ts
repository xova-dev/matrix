import type { MatrixConfig } from '../../src/types.js'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadMatrixConfig, normalizeMatrixConfig } from '../../src/config/index.js'
import { assertMatrixConfig } from '../../src/config/schema.js'
import { runExecutionPlan } from '../../src/execution/exec.js'
import { createExecutionPlan } from '../../src/execution/plan.js'
import { createMatrixRuntime } from '../../src/runtime/snapshot.js'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-version-'))
  directories.push(cwd)
  return cwd
}

function config(): MatrixConfig {
  return {
    suffixes: { staging: { name: '-staging', appId: '.staging' } },
    projects: { desktop: { targets: { build: 'node build.mjs' } } },
    products: { app: { version: '2.0.0', variants: { desktop: { project: 'desktop', version: '3.0.0' } } } },
  }
}

function plan(raw: MatrixConfig, cwd: string, externalEnv = {}) {
  return createExecutionPlan({ ...normalizeMatrixConfig(raw), cwd, externalEnv, productNames: Object.keys(raw.products), target: 'build', envName: 'staging' })
}

describe('product release versions', () => {
  it('resolves override > variant > product > project without identity suffixes', async () => {
    const cwd = await workspace()
    const packageContents = '{"name":"shared-shell","version":"1.0.0"}\n'
    await writeFile(path.join(cwd, 'package.json'), packageContents)
    const raw = config()
    const variant = raw.products.app!.variants.desktop as Exclude<MatrixConfig['products'][string]['variants'][string], string>
    const check = (expected: string, externalEnv = {}): void => {
      const task = plan(raw, cwd, externalEnv).tasks[0]!
      expect(task.version).toBe(expected)
      expect(task.env.MATRIX_PRODUCT_VERSION).toBe(expected)
      const runtime = createMatrixRuntime(Object.fromEntries(Object.entries(task.env).map(([key, value]) => [key, String(value)])))
      expect(runtime.product.version).toBe(expected)
      expect(runtime.config).not.toHaveProperty('productVersion')
    }
    check('4.0.0-rc.1+build.01', { MATRIX_PRODUCT_VERSION: '4.0.0-rc.1+build.01' })
    check('3.0.0')
    delete variant.version
    check('2.0.0')
    delete raw.products.app!.version
    check('1.0.0')
  })

  it('loads version declarations and honors product environment, dotenv, and shell overrides', async () => {
    const cwd = await workspace()
    const raw = config()
    raw.products.app!.env = { MATRIX_PRODUCT_VERSION: '4.0.0' }
    raw.products.app!.$env = { staging: { env: { MATRIX_PRODUCT_VERSION: '5.0.0' } } }
    await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default ${JSON.stringify(raw)}`)
    vi.stubEnv('MATRIX_PRODUCT_VERSION', undefined)
    const resolved = async (): Promise<string | undefined> => {
      const loaded = await loadMatrixConfig({ cwd, envName: 'staging' })
      expect(loaded.products.app!.version).toBe('2.0.0')
      expect(loaded.products.app!.variants.desktop!.version).toBe('3.0.0')
      return createExecutionPlan({ ...loaded, productNames: ['app'], target: 'build' }).tasks[0]!.version
    }
    expect(await resolved()).toBe('5.0.0')
    await writeFile(path.join(cwd, '.env.staging'), 'MATRIX_PRODUCT_VERSION=6.0.0\n')
    expect(await resolved()).toBe('6.0.0')
    vi.stubEnv('MATRIX_PRODUCT_VERSION', '7.0.0')
    expect(await resolved()).toBe('7.0.0')
  })

  it.each(['', ' ', '1.2', 'v1.2.3', '01.2.3', '1.2.3-01', '../private-value', '1.2.3\n', 123, false])('rejects invalid version %j without leaking it or falling back', async (version) => {
    const cwd = await workspace()
    const raw = config()
    expect(() => plan(raw, cwd, { MATRIX_PRODUCT_VERSION: version })).toThrow(
      /^Invalid release version at app:desktop:build release version \(MATRIX_PRODUCT_VERSION \/ variant\.version \/ product\.version\): expected SemVer$/,
    )
  })

  it.each(['../private-value', 123])('rejects invalid product and variant declarations %j', (version) => {
    const raw = config()
    expect(() => assertMatrixConfig({ ...raw, products: { app: { ...raw.products.app, version } } })).toThrow()
    expect(() => assertMatrixConfig({ ...raw, products: { app: { variants: { desktop: { project: 'desktop', version } } } } })).toThrow()
  })

  it('allows versionless non-artifact projects but requires a version for artifact tasks', async () => {
    const cwd = await workspace()
    const raw = config()
    raw.products.app = { variants: { desktop: 'desktop' } }
    const task = plan(raw, cwd).tasks[0]!
    expect(task).not.toHaveProperty('version')
    expect(task.env).not.toHaveProperty('MATRIX_PRODUCT_VERSION')
    expect(createMatrixRuntime({}).product).not.toHaveProperty('version')
    raw.projects.desktop!.targets.build = { command: 'node build.mjs', artifacts: { mode: 'archive' } }
    expect(() => plan(raw, cwd)).toThrow('Unable to read package version')
    await writeFile(path.join(cwd, 'package.json'), '{}')
    expect(() => plan(raw, cwd)).toThrow('Package version is required')
    await writeFile(path.join(cwd, 'package.json'), '{"version":"../invalid"}')
    expect(() => plan(raw, cwd)).toThrow('expected SemVer')
    raw.products.app.version = '2.0.0'
    expect(plan(raw, cwd).tasks[0]!.version).toBe('2.0.0')
  })

  it('uses independent product versions for child processes and artifacts of a shared project', async () => {
    const cwd = await workspace()
    const packageContents = '{"name":"shared-shell","version":"1.0.0"}\n'
    await writeFile(path.join(cwd, 'package.json'), packageContents)
    await writeFile(path.join(cwd, 'build.mjs'), [
      'import { mkdirSync, writeFileSync } from "node:fs"',
      'mkdirSync("dist", { recursive: true })',
      'writeFileSync("dist/version.txt", process.env.MATRIX_PRODUCT_VERSION)',
    ].join('\n'))
    const raw = config()
    raw.projects.desktop!.targets.build = { command: `"${process.execPath}" build.mjs`, artifacts: { mode: 'move' } }
    raw.products = {
      alpha: { version: '2.0.0', variants: { desktop: 'desktop' } },
      beta: { version: '3.0.0-rc.1+build.01', variants: { desktop: 'desktop' } },
      legacy: { variants: { desktop: 'desktop' } },
    }
    const execution = plan(raw, cwd)
    expect(execution.tasks.map(task => task.version)).toEqual(['2.0.0', '3.0.0-rc.1+build.01', '1.0.0'])
    await runExecutionPlan(execution)
    for (const task of execution.tasks) {
      const destination = path.join(cwd, 'artifacts', task.product, 'staging')
      const entries = await readdir(destination)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatch(new RegExp(`^desktop-${task.version!.replace(/[.+]/g, '\\$&')}-\\d{8}-\\d{6}$`))
      expect(await readFile(path.join(destination, entries[0]!, 'version.txt'), 'utf8')).toBe(task.version)
    }
    expect(await readFile(path.join(cwd, 'package.json'), 'utf8')).toBe(packageContents)
  })
})
