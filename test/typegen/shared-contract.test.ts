import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import path from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli/index.js'

const execute = promisify(execFile)
const originalCwd = process.cwd()
const directories: string[] = []
const plugin = fileURLToPath(new URL('../../src/unplugin/vite.ts', import.meta.url))
const cli = new URL('../../src/cli/index.ts', import.meta.url).href

beforeEach(() => {
  vi.stubEnv('VITEST', undefined)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  process.chdir(originalCwd)
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function configure(cwd: string, products = ['alpha', 'beta'], fields = true, admin = false): Promise<void> {
  await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default ${JSON.stringify({
    env: { APP_SHARED: 'shared-value', ADMIN_SHARED: 'admin-value' },
    envSchema: { APP_OPTIONAL: { type: 'string', optional: true } },
    projects: {
      web: { ...(admin ? { root: 'web' } : {}), targets: { build: 'node build.mjs', dev: 'node dev.mjs' } },
      ...(admin ? { admin: { root: 'admin', targets: { build: 'node build.mjs' } } } : {}),
    },
    products: Object.fromEntries(products.map(name => [name, {
      env: fields ? { [`APP_${name.toUpperCase()}`]: `${name}-private-value` } : {},
      variants: { web: 'web', ...(admin ? { admin: 'admin' } : {}) },
    }])),
  })}`)
}

async function workspace(conditional = false, admin = false): Promise<string> {
  const cwd = path.normalize(await realpath(await mkdtemp(path.join(os.tmpdir(), 'matrix-shared-contract-'))))
  directories.push(cwd)
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(cwd, 'node_modules'), 'junction')
  await writeFile(path.join(cwd, 'package.json'), '{"type":"module"}')
  await configure(cwd, ['alpha', 'beta'], true, admin)
  const scopes = [['web', 'APP_', admin ? path.join(cwd, 'web') : cwd], ...(admin ? [['admin', 'ADMIN_', path.join(cwd, 'admin')]] : [])]
  for (const [scope, prefix, directory] of scopes as [string, string, string][]) {
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'build.mjs'), 'import { build } from "vite"; await build();')
    await writeFile(path.join(directory, 'entry.mjs'), `
      import { matrix } from 'virtual:matrix/runtime/${scope}';
      export const snapshot = { config: matrix.config, product: matrix.product.key };
      console.log(JSON.stringify(snapshot));
    `)
    await writeFile(path.join(directory, 'vite.config.mjs'), `
      import matrix from ${JSON.stringify(plugin)};
      export default ({ command }) => ({
        ${conditional && scope === 'web' ? 'envDir: command === "serve" ? "development-env" : "production-env",' : ''}
        plugins: [matrix({ scope: '${scope}', envPrefix: '${prefix}' })],
        build: {
          outDir: 'dist-' + process.env.MATRIX_PRODUCT_KEY,
          lib: { entry: 'entry.mjs', formats: ['es'], fileName: () => 'entry.mjs' },
          minify: false,
        },
      });
    `)
  }
  await writeFile(path.join(cwd, 'dev.mjs'), `
    import { rename, writeFile } from 'node:fs/promises';
    import { writeFileSync } from 'node:fs';
    import { createServer } from 'vite';
    const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
    server.httpServer.once('close', () => writeFileSync('dev-cleanup', 'closed'));
    await server.listen();
    const { snapshot } = await server.ssrLoadModule('/entry.mjs');
    // Publish only the complete payload: file existence is the readiness signal.
    await writeFile('dev-ready.tmp', JSON.stringify({ url: server.resolvedUrls.local[0], snapshot }));
    await rename('dev-ready.tmp', 'dev-ready');
  `)
  if (conditional) {
    for (const [directory, key] of [['development-env', 'APP_DEV_ONLY'], ['production-env', 'APP_BUILD_ONLY']]) {
      await mkdir(path.join(cwd, directory!))
      await writeFile(path.join(cwd, directory!, '.env'), `${key}=branch-private-value\n`)
    }
  }
  process.chdir(cwd)
  return cwd
}

async function declaration(cwd: string, scope = 'web'): Promise<string> {
  return readFile(path.join(cwd, scope === 'admin' ? 'admin' : '.', `.matrix/types/matrix-runtime-${scope}.d.ts`), 'utf8')
}

function expectSharedContract(types: string): void {
  for (const field of ['alpha?: string', 'beta?: string', 'optional?: string', 'shared: string'])
    expect(types).toContain(`readonly ${field}`)
  for (const key of ['APP_ALPHA', 'APP_BETA', 'APP_OPTIONAL'])
    expect(types).toContain(`readonly ${key}?: string`)
  expect(types).not.toMatch(/private-value|admin-value|ADMIN_SHARED/)
}

async function runtime(cwd: string, product: string, admin = false): Promise<unknown> {
  const snapshots = await Promise.all((admin ? ['web', 'admin'] : ['.']).map(async (directory) => {
    const { stdout } = await execute(process.execPath, [path.join(cwd, directory, `dist-${product}/entry.mjs`)], { cwd })
    return JSON.parse(stdout.trim())
  }))
  expect(snapshots[0].product).toBe(product)
  if (admin)
    expect(snapshots[1].product).toBe(product)
  return { product, web: snapshots[0].config, ...(admin ? { admin: snapshots[1].config } : {}) }
}

function isolatedCli(cwd: string, args: string[], instrumentation = '') {
  // Node strips TypeScript but does not map the source tree's .js imports to .ts.
  const sourceLoader = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      try { return next(specifier, context); }
      catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw error;
        return next(specifier.slice(0, -3) + '.ts', context);
      }
    } });
    ${instrumentation}
    const { runCli } = await import(${JSON.stringify(cli)});
    await runCli(${JSON.stringify(args)});
  `
  return execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', sourceLoader], {
    cwd,
    env: { ...process.env },
    timeout: 25_000,
  })
}

describe('shared project declaration contract', () => {
  it('keeps the full prepared contract through single-product builds and switches without leaking runtime values', async () => {
    const cwd = await workspace(false, true)
    // Sibling roots keep this scope-isolation fixture independent of the
    // separate overlapping-root ownership regressions.
    const web = path.join(cwd, 'web')
    await runCli(['prepare'])
    const prepared = await declaration(web)
    expect(prepared).toContain('readonly alpha')
    expect(prepared).toContain('readonly beta')
    const admin = await declaration(cwd, 'admin')
    expect(admin).toContain('readonly shared: string')
    expect(admin).not.toMatch(/APP_ALPHA|APP_BETA|readonly alpha|readonly beta/)

    for (const product of ['alpha', 'beta']) {
      await runCli(['build', product])
      const built = await declaration(web)
      expect(built).toContain('readonly alpha')
      expect(built).toContain('readonly beta')
      expectSharedContract(built)
      expect(built).toBe(prepared)
      expect(await declaration(cwd, 'admin')).toBe(admin)
      expect(await runtime(cwd, product, true)).toEqual({
        product,
        web: { shared: 'shared-value', [product]: `${product}-private-value` },
        admin: { shared: 'admin-value' },
      })
    }
  }, 30_000)

  it('includes every associated product during selected preparation and removes stale fields after edits', async () => {
    const cwd = await workspace()
    await runCli(['prepare', 'alpha'])
    expectSharedContract(await declaration(cwd))

    await configure(cwd, ['alpha'])
    await runCli(['prepare', 'alpha'])
    const reduced = await declaration(cwd)
    expect(reduced).toContain('readonly alpha: string')
    expect(reduced).not.toMatch(/APP_BETA|readonly beta/)

    await configure(cwd, ['alpha'], false)
    await runCli(['prepare', 'alpha'])
    const cleared = await declaration(cwd)
    expect(cleared).toContain('readonly shared: string')
    expect(cleared).not.toMatch(/APP_ALPHA|APP_BETA|readonly alpha|readonly beta/)
  }, 30_000)

  it('includes real serve and build config branches in one stable contract', async () => {
    const cwd = await workspace(true)
    await runCli(['prepare', 'alpha'])
    const prepared = await declaration(cwd)
    expectSharedContract(prepared)
    expect(prepared).toContain('readonly devOnly?: string')
    expect(prepared).toContain('readonly buildOnly?: string')
    await runCli(['build', 'beta'])
    expect(await declaration(cwd)).toBe(prepared)
    expect(await runtime(cwd, 'beta')).toEqual({
      product: 'beta',
      web: { shared: 'shared-value', beta: 'beta-private-value', buildOnly: 'branch-private-value' },
    })
  }, 30_000)

  it('keeps all three real electron-vite scope contracts across shared-product builds', async () => {
    const cwd = await workspace()
    await rm(path.join(cwd, 'node_modules'))
    await mkdir(path.join(cwd, 'node_modules'))
    // Source-config bundling externalizes Matrix's dependencies into the fixture.
    // Link each package's physical directory, including scoped dependencies:
    // linking a scope directory can leave its relative pnpm links unresolved on Windows.
    const modules = fileURLToPath(new URL('../../node_modules', import.meta.url))
    const { dependencies } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    for (const name of Object.keys(dependencies)) {
      const destination = path.join(cwd, 'node_modules', name)
      await mkdir(path.dirname(destination), { recursive: true })
      await symlink(await realpath(path.join(modules, name)), destination, 'junction')
    }
    // Keep the example's real electron-vite/Vite pair instead of the root host.
    for (const name of ['vite', 'electron-vite'])
      await symlink(await realpath(fileURLToPath(new URL(`../../examples/electron-web/node_modules/${name}`, import.meta.url))), path.join(cwd, 'node_modules', name), 'junction')
    await rm(path.join(cwd, 'vite.config.mjs'))
    await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default ${JSON.stringify({
      env: { VITE_SHARED: 'shared-value', MAIN_VITE_MAIN_ONLY: 'main-private-value', PRELOAD_VITE_PRELOAD_ONLY: 'preload-private-value' },
      projects: { desktop: { targets: { build: 'node build.mjs' } } },
      products: Object.fromEntries(['alpha', 'beta'].map(product => [product, {
        env: { [`VITE_${product.toUpperCase()}`]: `${product}-private-value` },
        variants: { desktop: 'desktop' },
      }])),
    })}`)
    await writeFile(path.join(cwd, 'build.mjs'), 'import { build } from "electron-vite"; await build();')
    for (const scope of ['main', 'preload', 'renderer']) {
      await writeFile(path.join(cwd, `${scope}-entry.ts`), `
        import { matrix } from 'virtual:matrix/runtime${scope === 'renderer' ? '' : `/${scope}`}';
        console.log(JSON.stringify({ product: matrix.product.key, config: matrix.config }));
      `)
    }
    await writeFile(path.join(cwd, 'index.html'), '<script type="module" src="/renderer-entry.ts"></script>')
    await writeFile(path.join(cwd, 'electron.vite.config.mjs'), `
      import matrix from ${JSON.stringify(plugin)};
      export default {
        main: {
          plugins: [matrix({ scope: 'main' })],
          build: { outDir: 'out-' + process.env.MATRIX_PRODUCT_KEY + '/main', lib: { entry: 'main-entry.ts', fileName: () => 'entry.cjs' } },
        },
        preload: {
          plugins: [matrix({ scope: 'preload' })],
          build: { outDir: 'out-' + process.env.MATRIX_PRODUCT_KEY + '/preload', lib: { entry: 'preload-entry.ts', fileName: () => 'entry.cjs' } },
        },
        renderer: {
          root: '.', plugins: [matrix()],
          build: { outDir: 'out-' + process.env.MATRIX_PRODUCT_KEY + '/renderer', rollupOptions: { input: 'index.html' }, minify: false },
        },
      };
    `)
    const files = ['matrix-runtime-main.d.ts', 'matrix-runtime-preload.d.ts', 'matrix-runtime.d.ts']
    const types = () => Promise.all(files.map(file => readFile(path.join(cwd, '.matrix/types', file), 'utf8')))
    await runCli(['prepare', 'alpha'])
    const prepared = await types()
    for (const contract of prepared) {
      expect(contract).toContain('readonly alpha?: string')
      expect(contract).toContain('readonly beta?: string')
      expect(contract).not.toContain('private-value')
    }
    expect(prepared[0]).toContain('readonly mainOnly: string')
    expect(prepared[0]).not.toMatch(/preloadOnly|PRELOAD_VITE/)
    expect(prepared[1]).toContain('readonly preloadOnly: string')
    expect(prepared[1]).not.toMatch(/mainOnly|MAIN_VITE/)
    expect(prepared[2]).not.toMatch(/mainOnly|preloadOnly|MAIN_VITE|PRELOAD_VITE/)
    for (const product of ['alpha', 'beta']) {
      await runCli(['build', product])
      expect(await types()).toEqual(prepared)
      for (const scope of ['main', 'preload']) {
        const directory = path.join(cwd, `out-${product}`, scope)
        const entry = (await readdir(directory)).find(file => /\.(?:cjs|m?js)$/.test(file))!
        const { stdout } = await execute(process.execPath, [path.join(directory, entry)], { cwd })
        expect(JSON.parse(stdout.trim())).toEqual({
          product,
          config: { shared: 'shared-value', [product]: `${product}-private-value`, [`${scope}Only`]: `${scope}-private-value` },
        })
      }
      const assets = path.join(cwd, `out-${product}/renderer/assets`)
      const renderer = (await Promise.all((await readdir(assets)).filter(file => file.endsWith('.js')).map(file => readFile(path.join(assets, file), 'utf8')))).join('\n')
      expect(renderer).toContain(`${product}-private-value`)
      expect(renderer).not.toContain(`${product === 'alpha' ? 'beta' : 'alpha'}-private-value`)
      expect(renderer).not.toMatch(/main-private-value|preload-private-value/)
    }
  }, 30_000)

  it.skipIf(process.platform === 'win32')('keeps the serve contract and runtime stable until SIGINT closes the real dev server', async () => {
    const cwd = await workspace(true)
    await runCli(['prepare', 'alpha'])
    const prepared = await declaration(cwd)
    const running = isolatedCli(cwd, ['dev', 'beta'])
    // Attach a rejection handler immediately: SIGINT intentionally exits with 130.
    const stopped = running.catch(error => error)
    try {
      const ready = JSON.parse(await waitForFile(path.join(cwd, 'dev-ready')))
      expect((await fetch(new URL('/entry.mjs', ready.url))).status).toBe(200)
      expect(ready.snapshot).toEqual({
        product: 'beta',
        config: { shared: 'shared-value', beta: 'beta-private-value', devOnly: 'branch-private-value' },
      })
      expectSharedContract(await declaration(cwd))
      expect(await declaration(cwd)).toBe(prepared)
      running.child.kill('SIGINT')
      const result = await stopped
      expect(result.code).toBe(130)
      expect(await readFile(path.join(cwd, 'dev-cleanup'), 'utf8')).toBe('closed')
      await expect(fetch(new URL('/entry.mjs', ready.url))).rejects.toThrow()
      expect(await declaration(cwd)).toBe(prepared)
    }
    finally {
      if (running.child.exitCode === null)
        running.child.kill('SIGINT')
      await stopped
    }
  }, 30_000)

  it('preserves the contract when independent CLI processes demonstrably contend on the same lock', async () => {
    const cwd = await workspace()
    const owner = isolatedCli(cwd, ['prepare', 'alpha'], lockBarrier('owner'))
    const ownerDone = owner
    void ownerDone.catch(() => {})
    let contender: ReturnType<typeof isolatedCli> | undefined
    try {
      await waitForFile(path.join(cwd, 'owner-acquired'))
      contender = isolatedCli(cwd, ['build', 'beta'], lockBarrier('contender'))
      void contender.catch(() => {})
      // Written only when the second process receives EEXIST from the actual
      // lock mkdir. The first process cannot collect or publish before release.
      await waitForFile(path.join(cwd, 'contender-waiting'))
      await expect(readFile(path.join(cwd, '.matrix/types/matrix-runtime-web.d.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(path.join(cwd, 'release-owner'), '')
      await Promise.all([ownerDone, contender])
      expectSharedContract(await declaration(cwd))
      expect(await runtime(cwd, 'beta')).toEqual({
        product: 'beta',
        web: { shared: 'shared-value', beta: 'beta-private-value' },
      })
    }
    finally {
      await writeFile(path.join(cwd, 'release-owner'), '')
      await Promise.allSettled([ownerDone, ...(contender ? [contender] : [])])
    }
  }, 30_000)
})

async function waitForFile(file: string): Promise<string> {
  let content = ''
  await vi.waitFor(async () => {
    content = await readFile(file, 'utf8')
  }, { timeout: 15_000, interval: 20 })
  return content
}

function lockBarrier(role: 'owner' | 'contender'): string {
  return `
    const fs = (await import('node:fs/promises')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const mkdir = fs.mkdir;
    fs.mkdir = async function (directory, ...args) {
      if (!String(directory).match(/matrix-types-.*\\.lock$/)) return mkdir(directory, ...args);
      try {
        const result = await mkdir(directory, ...args);
        if (${JSON.stringify(role)} === 'owner') {
          await fs.writeFile('owner-acquired', '');
          while (true) {
            try { await fs.access('release-owner'); break; }
            catch { await new Promise(resolve => setTimeout(resolve, 10)); }
          }
        }
        return result;
      } catch (error) {
        if (error.code === 'EEXIST') await fs.writeFile(${JSON.stringify(`${role}-waiting`)}, '');
        throw error;
      }
    };
    syncBuiltinESMExports();
  `
}
