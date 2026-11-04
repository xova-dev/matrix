import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'pathe'
import { describe, expect, it, vi } from 'vitest'
import { findTypeHost, resolveHostTypes, TypePreparationCancelled } from '../../src/typegen/prepare.js'
import { currentProcessEnv } from '../../src/utils/env.js'
import { withCleanup } from '../../src/utils/errors.js'
import { temporaryDirectory } from '../helpers/temporary-directory.js'

async function fixture(settings: Record<string, unknown> = {}): Promise<string> {
  const root = await temporaryDirectory('matrix-nuxt-lifecycle-')
  const write = async (file: string, value: unknown): Promise<void> => {
    const location = path.join(root, file)
    await mkdir(path.dirname(location), { recursive: true })
    await writeFile(location, typeof value === 'string' ? value : JSON.stringify(value))
  }
  await write('package.json', { type: 'module' })
  await write('nuxt.config.ts', 'export default {}')
  await write('settings.json', settings)
  await write('node_modules/nuxt/package.json', { type: 'module', exports: {
    '.': settings.stringExports ? './index.js' : { import: './index.js' },
    './kit': settings.stringExports ? './kit.js' : { import: './kit.js' },
    './package.json': './package.json',
  } })
  await write('node_modules/nuxt/kit.js', `
    import { createRequire } from 'node:module'
    export { loadNuxt, buildNuxt } from './index.js'
    export const resolveModule = (id, options) => createRequire(options.url).resolve(id)
  `)
  await write('node_modules/nuxt/index.js', `
    import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs'
    const settings = JSON.parse(readFileSync('settings.json', 'utf8'))
    const log = value => appendFileSync('lifecycle', value + ';')
    let watcher
    export async function loadNuxt(options) {
      if (options.ready !== false) throw Error('ready must be explicit')
      if (options.configFile !== undefined) throw Error('Layers must retain native config discovery')
      log('load')
      return {
        options: { builder: '@nuxt/vite-builder', experimental: { viteEnvironmentApi: settings.environmentApi ?? false } },
        async ready() {
          log('ready')
          writeFileSync('ready.pid', String(process.pid))
          if (settings.delayedExit) process.on('SIGTERM', () => {
            writeFileSync('draining', '');
            setInterval(() => { if (existsSync('release')) process.exit(0); }, 10);
          })
          if (settings.noGracefulSignals) process.removeAllListeners('SIGTERM')
          if (settings.readyError) throw Error('ready original failure')
          if (settings.hang) {
            watcher = setInterval(() => {}, 1000)
            await new Promise(() => {})
          }
        },
        async callHook(name, config) {
          await new Promise(resolve => setTimeout(resolve, 10))
          config.finalField = 'late hook'
          log('late-hook-and-interceptors')
          if (settings.hookError) throw Error('hook original failure')
        },
        async close() {
          log('close')
          clearInterval(watcher)
          await new Promise(resolve => setTimeout(resolve, 20))
          if (settings.closeError) throw Error('close original failure')
          if (settings.closeHang) {
            setInterval(() => {}, 1000)
            await new Promise(() => {})
          }
          log('closed')
        },
      }
    }
    export async function buildNuxt(nuxt) {
      log('build')
      await nuxt.callHook('vite:configResolved', { plugins: [] }, { isClient: true })
      throw Error('builder must stop before serving or building')
    }
  `)
  await write('node_modules/@nuxt/vite-builder/package.json', { type: 'module', exports: './index.js' })
  await write('node_modules/@nuxt/vite-builder/index.js', '')
  await write('node_modules/vite/package.json', { type: 'module', exports: './index.js' })
  await write('node_modules/vite/index.js', `
    import { appendFileSync } from 'node:fs'
    export async function resolveConfig(config, command) {
      if (config.finalField !== 'late hook') throw Error('late Nuxt hooks were skipped')
      if (config.configFile !== false) throw Error('Nuxt config must not load as Vite config')
      appendFileSync('lifecycle', 'resolved-' + command + ';')
    }
  `)
  return root
}

describe('nuxt type preparation lifecycle', () => {
  it.each(['serve', 'build'] as const)('awaits all final Nuxt hooks and closes once for %s collection', async (command) => {
    const root = await fixture({ stringExports: command === 'build' })
    expect(await resolveHostTypes(root, currentProcessEnv(), { host: (await findTypeHost(root))!, mode: 'test', command })).toBeNull()
    expect(await readFile(path.join(root, 'lifecycle'), 'utf8')).toBe(`load;ready;build;late-hook-and-interceptors;resolved-${command};close;closed;`)
  })

  it.each([
    [{ readyError: true }, 'ready original failure'],
    [{ hookError: true }, 'hook original failure'],
    [{ hookError: true, closeError: true }, 'hook original failure; Nuxt close failed: close original failure'],
    [{ environmentApi: true }, 'does not support experimental.viteEnvironmentApi'],
  ])('retains setup/config failures and cleanup errors: %j', async (settings, message) => {
    const root = await fixture(settings)
    await expect(resolveHostTypes(root, currentProcessEnv(), { host: (await findTypeHost(root))!, mode: 'test' })).rejects.toThrow(message)
    expect((await readFile(path.join(root, 'lifecycle'), 'utf8')).match(/close;/g)).toHaveLength(1)
  })

  it.each([false, true])('cancels a pending Nuxt ready with bounded cleanup without OS signal handlers (hang=%s)', async (closeHang) => {
    const root = await fixture({ hang: true, closeHang, noGracefulSignals: true })
    const controller = new AbortController()
    const running = resolveHostTypes(root, currentProcessEnv(), { host: (await findTypeHost(root))!, mode: 'test' }, controller.signal)
    void running.catch(() => undefined)
    await vi.waitFor(() => access(path.join(root, 'ready.pid')), { timeout: 3000 })
    const pid = Number(await readFile(path.join(root, 'ready.pid'), 'utf8'))
    controller.abort()
    await expect(running).rejects.toBeInstanceOf(TypePreparationCancelled)
    expect(() => process.kill(pid, 0)).toThrow()
    const log = await readFile(path.join(root, 'lifecycle'), 'utf8')
    expect(log).toContain('close;')
    expect(log.includes('closed;')).toBe(!closeHang)
  })

  it.skipIf(process.platform === 'win32')('retains cancellation arriving after collection while the process container drains', async () => {
    const root = await fixture({ delayedExit: true })
    const controller = new AbortController()
    const running = resolveHostTypes(root, currentProcessEnv(), { host: (await findTypeHost(root))!, mode: 'test' }, controller.signal)
    void running.catch(() => undefined)
    await withCleanup(async () => {
      await vi.waitFor(() => access(path.join(root, 'draining')), { timeout: 5_000 })
      controller.abort()
      await writeFile(path.join(root, 'release'), '')
      await expect(running).rejects.toBeInstanceOf(TypePreparationCancelled)
      const pid = Number(await readFile(path.join(root, 'ready.pid'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    }, async () => {
      controller.abort()
      await writeFile(path.join(root, 'release'), '')
      await running.catch((error) => {
        if (!(error instanceof TypePreparationCancelled))
          throw error
      })
    })
  }, 45_000)
})
