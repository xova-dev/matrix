import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { access, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import path from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli as executeCli } from '../../src/cli/index.js'
import { withCleanup } from '../../src/utils/errors.js'
import { processExists, releaseRecordedProcesses } from '../helpers/process-fixture.js'
import { temporaryDirectory } from '../helpers/temporary-directory.js'
import { createTestExecution } from '../helpers/test-execution.js'
import { releaseResources, testResources } from '../helpers/test-resources.js'
import { cleanupTimeout, fixtureReadyTimeout, workflowTestTimeout } from '../helpers/timeouts.js'

const originalCwd = process.cwd()
const execute = promisify(execFile)
const cli = new URL('../../src/cli/index.ts', import.meta.url).href
const plugin = fileURLToPath(new URL('../../src/unplugin/vite.ts', import.meta.url))
const executions = createTestExecution()
const runCli = (args: string[]) => executions.run(() => executeCli(args))

beforeEach(context => executions.begin(context.signal))

afterEach(async () => {
  try {
    await executions.cleanup()
  }
  finally {
    process.chdir(originalCwd)
    vi.unstubAllEnvs()
  }
}, cleanupTimeout)

async function workspace(directory?: string): Promise<string> {
  const cwd = directory ?? await temporaryDirectory('matrix-context-lifecycle-', () => executions.cleanup())
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(cwd, 'node_modules'), 'junction')
  await writeFile(path.join(cwd, 'package.json'), '{"type":"module","version":"1.0.0"}')
  await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default ${JSON.stringify({
    projects: { web: { prepare: ['node prepare.mjs', 'node verify.mjs prepare'], targets: { build: ['node verify.mjs target', 'node build.mjs'], dev: 'node service.mjs' } } },
    products: {
      alpha: { appId: 'app.alpha', version: '2.0.0', env: { VITE_ALPHA: 'alpha' }, variants: { web: 'web' } },
      beta: { appId: 'app.beta', version: '3.0.0', env: { VITE_BETA: 'beta' }, variants: { web: 'web' } },
    },
  })}`)
  await writeFile(path.join(cwd, 'context.mjs'), `
    export const context = () => Object.fromEntries(['MATRIX_PRODUCT_KEY', 'MATRIX_PRODUCT_APP_ID', 'MATRIX_PRODUCT_VERSION', 'MATRIX_VARIANT', 'MATRIX_ENV_NAME', 'MATRIX_TARGET', 'NODE_ENV'].map(key => [key, process.env[key]]));
  `)
  await writeFile(path.join(cwd, 'prepare.mjs'), `
    import assert from 'node:assert/strict';
    import { copyFileSync, writeFileSync } from 'node:fs';
    import { context } from './context.mjs';
    assert.equal(process.env.__MATRIX_TYPE_CONTRACT, undefined);
    copyFileSync('host-template.mjs', 'vite.config.mjs');
    writeFileSync('generated.json', JSON.stringify(context()));
  `)
  await writeFile(path.join(cwd, 'verify.mjs'), `
    import assert from 'node:assert/strict';
    import { appendFileSync, readFileSync } from 'node:fs';
    import { context } from './context.mjs';
    assert.deepEqual(JSON.parse(readFileSync('generated.json')), context());
    appendFileSync('events.jsonl', JSON.stringify({ phase: process.argv[2], ...context() }) + '\\n');
  `)
  await writeFile(path.join(cwd, 'host-template.mjs'), `
    import assert from 'node:assert/strict';
    import { appendFileSync, readFileSync } from 'node:fs';
    import { context } from './context.mjs';
    import matrix from ${JSON.stringify(plugin)};
    assert.deepEqual(JSON.parse(readFileSync('generated.json')), context());
    appendFileSync('events.jsonl', JSON.stringify({ phase: 'host', ...context() }) + '\\n');
    export default { plugins: [matrix({ types: true })], build: { write: false, lib: { entry: 'entry.mjs', formats: ['es'] } } };
  `)
  await writeFile(path.join(cwd, 'entry.mjs'), 'export const value = 1')
  await writeFile(path.join(cwd, 'build.mjs'), `import { build } from 'vite'; await build();`)
  await writeFile(path.join(cwd, 'service.mjs'), 'setInterval(() => {}, 1000)')
  process.chdir(cwd)
  return cwd
}

function isolated(cwd: string, args: string[], observeContention = false) {
  const loader = `
    ${observeContention
      ? `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const mkdir = fs.mkdir;
    fs.mkdir = async (directory, ...args) => {
      try { return await mkdir(directory, ...args); }
      catch (error) {
        if (error.code === 'EEXIST' && /matrix-types-.*\\.lock$/.test(String(directory)))
          await fs.writeFile('lock-contended', '');
        throw error;
      }
    };
    syncBuiltinESMExports();
    `
      : ''}
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
      if (e.code !== 'ERR_MODULE_NOT_FOUND' || !s.endsWith('.js')) throw e;
      return next(s.slice(0, -3) + '.ts', c);
    } } });
    const { runCli } = await import(${JSON.stringify(cli)});
    await runCli(${JSON.stringify(args)});
  `
  // Callers acquire this subprocess through testResources before it can start;
  // in-process CLI execution and isolated-process ownership stay separate.
  return execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', loader], { cwd, timeout: 90_000 })
}

async function nativeWorkspace(config: object, directory?: string): Promise<string> {
  const cwd = directory ?? await temporaryDirectory('matrix-native-lifecycle-', () => executions.cleanup())
  await writeFile(path.join(cwd, 'package.json'), '{"type":"module","version":"1.0.0"}')
  await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default ${JSON.stringify(config)}`)
  process.chdir(cwd)
  return cwd
}

// Real host collection starts several owned processes per product/context.
// Keep one bounded integration budget that also includes native Windows startup.
describe('context preparation lifecycle', { timeout: workflowTestTimeout }, () => {
  it('keeps explicit native preparation contexts stable when preparation changes the package version', async () => {
    const cwd = await nativeWorkspace({
      projects: { app: { typegen: false, prepare: 'node prepare.mjs', targets: { build: 'node -e "0"' } } },
      products: { app: { variants: { web: 'app' } } },
    })
    await writeFile(path.join(cwd, 'prepare.mjs'), `
      import { appendFileSync, writeFileSync } from 'node:fs';
      appendFileSync('contexts', process.env.MATRIX_TARGET + ':' + process.env.MATRIX_PRODUCT_VERSION + '\\n');
      writeFileSync('package.json', JSON.stringify({ type: 'module', version: '2.0.0' }));
    `)
    await runCli(['prepare', 'app'])
    expect(await readFile(path.join(cwd, 'contexts'), 'utf8')).toBe('dev:1.0.0\nbuild:1.0.0\n')
    // Snapshots belong to one invocation, not a permanent project cache.
    await runCli(['prepare', 'app'])
    expect(await readFile(path.join(cwd, 'contexts'), 'utf8')).toBe('dev:1.0.0\nbuild:1.0.0\ndev:2.0.0\nbuild:2.0.0\n')
  })

  it.each(['prepare', 'build'])('shares the planned version with every host context during %s', async (command) => {
    const cwd = await workspace()
    await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default ${JSON.stringify({
      projects: {
        app: { prepare: 'node mutate.mjs', targets: { build: 'node record.mjs target' } },
        shared: { targets: { build: 'node record.mjs target' } },
      },
      products: {
        alpha: { variants: { first: 'app', second: 'shared' } },
        beta: { variants: { other: 'shared' } },
      },
    })}`)
    await writeFile(path.join(cwd, 'record.mjs'), `
      import { appendFileSync } from 'node:fs';
      appendFileSync('versions', [process.argv[2] ?? 'host', process.env.MATRIX_PRODUCT_KEY, process.env.MATRIX_VARIANT, process.env.MATRIX_TARGET, process.env.MATRIX_PRODUCT_VERSION].join(':') + '\\n');
    `)
    await writeFile(path.join(cwd, 'mutate.mjs'), `
      import './record.mjs';
      import { writeFileSync } from 'node:fs';
      writeFileSync('package.json', JSON.stringify({ type: 'module', version: '2.0.0' }));
    `)
    await writeFile(path.join(cwd, 'vite.config.mjs'), `import './record.mjs'; export default {};`)
    await runCli([command, 'alpha'])
    const events = (await readFile(path.join(cwd, 'versions'), 'utf8')).trim().split('\n')
    // Includes an unselected product and a project without a preparation command.
    expect(events).toContain('host:beta:other:build:1.0.0')
    expect(events).toContain('host:alpha:second:dev:1.0.0')
    if (command === 'build')
      expect(events).toContain('target:alpha:second:build:1.0.0')
    expect(events.every(event => event.endsWith(':1.0.0'))).toBe(true)
  })

  it.each(['prepare', 'build'])('does not surface an unused context snapshot error during native %s', async (command) => {
    const cwd = await nativeWorkspace({
      projects: {
        app: { typegen: false, prepare: 'node record.mjs', targets: { build: 'node record.mjs' } },
        unused: { root: 'unused', targets: { build: 'node -e "0"' } },
      },
      products: { app: { variants: { web: 'app' } }, unused: { variants: { web: 'unused' } } },
    })
    await mkdir(path.join(cwd, 'unused'))
    await writeFile(path.join(cwd, 'unused/package.json'), '{ invalid package JSON')
    await writeFile(path.join(cwd, 'record.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("ran", "yes")')
    await runCli([command, 'app'])
    expect(await readFile(path.join(cwd, 'ran'), 'utf8')).toBe('yes')
  })

  it.skipIf(process.platform !== 'win32').each([false, true])('retains Windows ownership after root and intermediate exit (detached descendant: %s)', async (detached) => {
    const cwd = await nativeWorkspace({
      projects: { web: {
        typegen: false,
        prepare: 'node setup.mjs',
        targets: {
          dev: 'node parent.mjs',
          build: { command: 'node build.mjs', dependsOn: [{ variant: 'web', target: 'dev', condition: 'completed' }] },
        },
      } },
      products: { alpha: { variants: { web: 'web' } }, beta: { variants: { web: 'web' } } },
    })
    await writeFile(path.join(cwd, 'setup.mjs'), `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      if (process.env.MATRIX_TARGET === 'build')
        assert.throws(() => process.kill(Number(readFileSync('descendant.pid', 'utf8')), 0), { code: 'ESRCH' });
      writeFileSync('generated', process.env.MATRIX_PRODUCT_KEY);
    `)
    await writeFile(path.join(cwd, 'parent.mjs'), `
      import { spawn } from 'node:child_process';
      import { existsSync, rmSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      rmSync('descendant.pid', { force: true });
      spawn(process.execPath, ['middle.mjs'], { stdio: 'ignore' }).unref();
      while (!existsSync('descendant.pid')) await setTimeout(10);
    `)
    await writeFile(path.join(cwd, 'middle.mjs'), `
      import { spawn } from 'node:child_process';
      import { existsSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      spawn(process.execPath, ['descendant.mjs'], { stdio: 'ignore', detached: ${detached} }).unref();
      // Windows may terminate a non-detached child when its Node parent exits.
      // Observe startup before exiting instead of racing away its ready marker.
      while (!existsSync('descendant.pid')) await setTimeout(10);
    `)
    await writeFile(path.join(cwd, 'descendant.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync('descendant.pid', String(process.pid));
      setInterval(() => {}, 1000);
    `)
    await writeFile(path.join(cwd, 'build.mjs'), `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      assert.equal(readFileSync('generated', 'utf8'), process.env.MATRIX_PRODUCT_KEY);
    `)
    for (const product of ['alpha', 'beta', 'alpha'])
      await runCli(['build', product])
  })

  it.skipIf(process.platform !== 'win32')('drains the Windows job after the CLI coordinator is killed', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix-native-owner-death-')
    const cwd = await nativeWorkspace({
      projects: { web: { typegen: false, targets: { build: 'node service.mjs' } } },
      products: { app: { variants: { web: 'web' } } },
    }, resources.root)
    await writeFile(path.join(cwd, 'service.mjs'), `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      writeFileSync('service.pid', String(process.pid));
      spawn(process.execPath, ['descendant.mjs'], { stdio: 'ignore' }).unref();
      setInterval(() => {}, 1000);
    `)
    await writeFile(path.join(cwd, 'descendant.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync('descendant.pid', String(process.pid));
      setInterval(() => {}, 1000);
    `)
    const { execution } = await resources.acquire(() => {
      const execution = isolated(cwd, ['build', 'app'])
      void execution.catch(() => undefined)
      return { execution }
    }, async ({ execution }) => {
      await withCleanup(async () => {
        execution.child.kill('SIGKILL')
        await execution.catch(() => undefined)
      }, () => releaseRecordedProcesses(['service.pid', 'descendant.pid'].map(file => path.join(cwd, file))))
      const identity = await realpath(cwd)
      await rm(path.join(os.tmpdir(), `matrix-types-${createHash('sha256').update(identity).digest('hex')}.lock`), { recursive: true, force: true })
    })
    await withCleanup(async () => {
      await resources.poll(() => access(path.join(cwd, 'descendant.pid')))
      const pid = Number(await readFile(path.join(cwd, 'descendant.pid'), 'utf8'))
      execution.child.kill('SIGKILL')
      await vi.waitFor(() => expect(processExists(pid)).toBe(false), { timeout: fixtureReadyTimeout })
    }, () => resources.dispose())
  })

  it('releases a completed service before preparing a dependent in the same directory', async () => {
    const cwd = await nativeWorkspace({
      projects: { web: {
        typegen: false,
        prepare: 'node setup.mjs',
        targets: {
          dev: 'node -e "0"',
          build: { command: 'node build.mjs', dependsOn: [{ variant: 'web', target: 'dev', condition: 'completed' }] },
        },
      } },
      products: { app: { variants: { web: 'web' } } },
    })
    await writeFile(path.join(cwd, 'setup.mjs'), '')
    await writeFile(path.join(cwd, 'build.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("built", "yes")')
    await runCli(['build', 'app'])
    expect(await readFile(path.join(cwd, 'built'), 'utf8')).toBe('yes')
  })

  it.each(['test', 'build'])('does not resolve unrelated type owners for a native %s target with automatic discovery', async (target) => {
    const cwd = await nativeWorkspace({
      projects: {
        app: { root: 'app', targets: { [target]: 'node test.mjs' } },
        unused: { root: 'broken', targets: { build: 'node -e "0"' } },
      },
      products: { app: { variants: { web: 'app' } } },
    })
    await mkdir(path.join(cwd, 'app'))
    await symlink(path.join(cwd, 'absent'), path.join(cwd, 'broken'), 'junction')
    await writeFile(path.join(cwd, 'app/test.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("ran", "yes")')
    await runCli([target, 'app'])
    expect(await readFile(path.join(cwd, 'app/ran'), 'utf8')).toBe('yes')
  })

  it.each(['prepare', 'build', 'dev'])('prepares only selected native contexts through %s without resolving unrelated type owners', async (command) => {
    const cwd = await nativeWorkspace({
      projects: {
        app: {
          root: 'app',
          typegen: false,
          prepare: ['node setup.mjs', 'node verify.mjs'],
          targets: { dev: 'node target.mjs', build: 'node target.mjs' },
        },
        unused: { root: 'broken', targets: { build: 'node -e "0"' } },
      },
      products: { alpha: { variants: { web: 'app' } }, beta: { variants: { web: 'app' } } },
    })
    await mkdir(path.join(cwd, 'app'))
    await symlink(path.join(cwd, 'absent'), path.join(cwd, 'broken'), 'junction')
    await writeFile(path.join(cwd, 'app/setup.mjs'), `
      import { appendFileSync, writeFileSync } from 'node:fs';
      const context = process.env.MATRIX_PRODUCT_KEY + ':' + process.env.MATRIX_TARGET;
      writeFileSync('generated', context);
      appendFileSync('events', 'prepare:' + context + '\\n');
    `)
    await writeFile(path.join(cwd, 'app/verify.mjs'), `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      assert.equal(readFileSync('generated', 'utf8'), process.env.MATRIX_PRODUCT_KEY + ':' + process.env.MATRIX_TARGET);
    `)
    await writeFile(path.join(cwd, 'app/target.mjs'), `
      import './verify.mjs';
      import { appendFileSync } from 'node:fs';
      appendFileSync('events', 'target:' + process.env.MATRIX_PRODUCT_KEY + ':' + process.env.MATRIX_TARGET + '\\n');
    `)
    for (const product of ['alpha', 'beta', 'alpha'])
      await runCli([command, product])
    expect((await readFile(path.join(cwd, 'app/events'), 'utf8')).trim().split('\n')).toEqual(
      ['alpha', 'beta', 'alpha'].flatMap(product => command === 'prepare'
        ? [`prepare:${product}:dev`, `prepare:${product}:build`]
        : [`prepare:${product}:${command}`, `target:${product}:${command}`]),
    )
    await expect(access(path.join(cwd, 'app/.matrix'))).rejects.toThrow()
  })

  it('stops explicit native preparation on failure without advancing its array or context', async () => {
    const cwd = await nativeWorkspace({
      projects: {
        app: { typegen: false, prepare: ['node fail.mjs', 'node next.mjs'], targets: { build: 'node next.mjs' } },
        unused: { root: 'broken', targets: { build: 'node -e "0"' } },
      },
      products: { app: { variants: { web: 'app' } } },
    })
    await symlink(path.join(cwd, 'absent'), path.join(cwd, 'broken'), 'junction')
    await writeFile(path.join(cwd, 'fail.mjs'), `
      import { appendFileSync } from 'node:fs';
      appendFileSync('contexts', process.env.MATRIX_TARGET + '\\n');
      throw new Error('native preparation failed');
    `)
    await writeFile(path.join(cwd, 'next.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("advanced", "yes")')
    await expect(runCli(['prepare', 'app'])).rejects.toThrow()
    expect(await readFile(path.join(cwd, 'contexts'), 'utf8')).toBe('dev\n')
    await expect(access(path.join(cwd, 'advanced'))).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32').each([false, true])('drains surviving descendants before releasing a completed service directory (cancel: %s)', async (cancelDuringCleanup) => {
    const cwd = await nativeWorkspace({
      projects: { web: {
        typegen: false,
        prepare: 'node setup.mjs',
        targets: {
          dev: 'node service.mjs',
          build: { command: 'node -e "0"', dependsOn: [{ variant: 'web', target: 'dev', condition: 'completed' }] },
        },
      } },
      products: { app: { variants: { web: 'web' } } },
    })
    await writeFile(path.join(cwd, 'setup.mjs'), `
      import { readFileSync } from 'node:fs';
      import assert from 'node:assert/strict';
      if (process.env.MATRIX_TARGET === 'build') assert.equal(readFileSync('descendant-stopped', 'utf8'), 'yes');
    `)
    await writeFile(path.join(cwd, 'service.mjs'), `
      import { spawn } from 'node:child_process';
      import { existsSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      spawn(process.execPath, ['descendant.mjs'], { stdio: 'ignore' }).unref();
      while (!existsSync('descendant-ready')) await setTimeout(20);
      process.exit(0);
    `)
    await writeFile(path.join(cwd, 'descendant.mjs'), `
      import { existsSync, writeFileSync } from 'node:fs';
      import { setTimeout as delay } from 'node:timers/promises';
      setInterval(() => {}, 1000);
      process.once('SIGTERM', async () => {
        writeFileSync('cleanup-started', '');
        while (!existsSync('release-cleanup')) await delay(20);
        writeFileSync('descendant-stopped', 'yes');
        process.exit(0);
      });
      writeFileSync('descendant-ready', '');
    `)
    if (!cancelDuringCleanup)
      await writeFile(path.join(cwd, 'release-cleanup'), '')
    const execution = executions.run(() => executeCli(['build', 'app']), () => {
      try {
        writeFileSync(path.join(cwd, 'release-cleanup'), '')
      }
      finally {
        process.emit('SIGTERM')
      }
    })
    void execution.catch(() => undefined)
    if (cancelDuringCleanup) {
      await vi.waitFor(() => access(path.join(cwd, 'cleanup-started')), { timeout: fixtureReadyTimeout })
      process.emit('SIGINT')
      await writeFile(path.join(cwd, 'release-cleanup'), '')
    }
    await execution
    expect(await readFile(path.join(cwd, 'descendant-stopped'), 'utf8')).toBe('yes')
  })

  it.each(['cleanup', 'delivery', 'unclean', 'target'] as const)('protects a live service from another project artifact %s', async (operation) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as net.AddressInfo).port
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    const cwd = await nativeWorkspace({
      artifacts: { root: operation === 'delivery' ? 'live' : 'artifacts' },
      projects: {
        live: { root: operation === 'delivery' ? 'live/app/development' : 'live', typegen: false, targets: { dev: { command: 'node service.mjs', readyWhen: { type: 'port', port } } } },
        builder: { root: 'builder', typegen: false, targets: { build: {
          command: 'node build.mjs',
          outputDir: operation !== 'delivery' ? '../live' : 'dist',
          ...(operation === 'target' ? {} : { artifacts: { mode: 'archive', clean: operation !== 'unclean' } }),
          dependsOn: [{ variant: 'live', target: 'dev', condition: 'ready' }],
        } } },
      },
      products: { app: { version: '1.0.0', variants: { builder: 'builder', live: 'live' } } },
    })
    const live = path.join(cwd, operation === 'delivery' ? 'live/app/development' : 'live')
    await mkdir(live, { recursive: true })
    await mkdir(path.join(cwd, 'builder'))
    await writeFile(path.join(live, 'sentinel'), 'keep')
    await writeFile(path.join(live, 'service.mjs'), `import net from 'node:net'; net.createServer().listen(${port}, '127.0.0.1')`)
    await writeFile(path.join(cwd, 'builder/build.mjs'), operation === 'delivery'
      ? 'import { writeFileSync } from "node:fs"; writeFileSync("dist/built", "yes")'
      : 'import { writeFileSync } from "node:fs"; writeFileSync("../live/sentinel", "overwritten"); writeFileSync("started", "yes")')
    await expect(runCli(['build', 'app', '--variant', 'builder', '--env', 'development'])).rejects.toThrow('Use isolated project roots')
    expect(await readFile(path.join(live, 'sentinel'), 'utf8')).toBe('keep')
    if (operation !== 'delivery')
      await expect(access(path.join(cwd, 'builder/started'))).rejects.toThrow()
  })

  it.each(['success', 'failure', 'cancel'] as const)('drains host descendants before releasing context ownership (%s)', async (outcome) => {
    const cwd = await workspace()
    await writeFile(path.join(cwd, 'watcher.mjs'), `
      import { readFileSync, writeFileSync } from 'node:fs';
      const original = readFileSync('generated.json', 'utf8');
      process.once('SIGTERM', () => {
        writeFileSync('watcher-stopped', JSON.stringify({ original, actual: readFileSync('generated.json', 'utf8') }));
        process.exit(0);
      });
      writeFileSync('watcher.pid', String(process.pid));
      writeFileSync('watcher-ready', '');
      setInterval(() => {}, 1000);
    `)
    await writeFile(path.join(cwd, 'host-template.mjs'), `
      import { spawn } from 'node:child_process';
      import { existsSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      if (process.env.MATRIX_PRODUCT_KEY === 'alpha' && process.env.MATRIX_TARGET === 'dev') {
        spawn(process.execPath, ['watcher.mjs'], { stdio: 'ignore' }).unref();
        while (!existsSync('watcher-ready')) await setTimeout(10);
        ${outcome === 'cancel' ? 'await new Promise(() => {});' : ''}
        ${outcome === 'failure' ? 'throw new Error("host failure");' : ''}
      }
      export default {};
    `)
    // A next-context write must see proof that the previous consumer released it.
    await writeFile(path.join(cwd, 'prepare.mjs'), `
      import assert from 'node:assert/strict';
      import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
      import { context } from './context.mjs';
      if (existsSync('watcher-ready')) {
        if (process.platform === 'win32')
          assert.throws(() => process.kill(Number(readFileSync('watcher.pid', 'utf8')), 0), { code: 'ESRCH' });
        else
          assert.ok(existsSync('watcher-stopped'));
      }
      copyFileSync('host-template.mjs', 'vite.config.mjs');
      writeFileSync('generated.json', JSON.stringify(context()));
    `)
    const execution = runCli(['prepare', 'alpha'])
    void execution.catch(() => undefined)
    if (outcome === 'cancel') {
      await vi.waitFor(() => access(path.join(cwd, 'watcher-ready')), { timeout: fixtureReadyTimeout })
      process.emit('SIGINT')
    }
    if (outcome === 'failure')
      await expect(execution).rejects.toThrow('host failure')
    else
      await execution
    if (process.platform === 'win32') {
      const pid = Number(await readFile(path.join(cwd, 'watcher.pid'), 'utf8'))
      expect(processExists(pid)).toBe(false)
    }
    else {
      const observed = JSON.parse(await readFile(path.join(cwd, 'watcher-stopped'), 'utf8'))
      expect(observed.actual).toBe(observed.original)
    }
  })

  it.skipIf(process.platform === 'win32')('refuses to reclaim a dead CLI lock while its target can still consume product inputs', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix-dead-cli-')
    const cwd = await nativeWorkspace({
      projects: { web: { typegen: false, prepare: 'node setup.mjs', targets: { build: 'node build.mjs' } } },
      products: { alpha: { variants: { web: 'web' } }, beta: { variants: { web: 'web' } } },
    }, resources.root)
    await writeFile(path.join(cwd, 'setup.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("generated", process.env.MATRIX_PRODUCT_KEY)')
    await writeFile(path.join(cwd, 'build.mjs'), `
      import { existsSync, writeFileSync, readFileSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      if (process.env.MATRIX_PRODUCT_KEY === 'alpha') {
        writeFileSync('alpha.pid', String(process.pid));
        while (!existsSync('release-alpha')) await setTimeout(20);
        writeFileSync('observed', readFileSync('generated'));
      }
    `)
    const { owner } = await resources.acquire(() => {
      const owner = isolated(cwd, ['build', 'alpha'])
      void owner.catch(() => undefined)
      return { owner }
    }, async ({ owner }) => {
      // The dead coordinator may leave inherited pipes open in its target.
      // Stop both independently before awaiting close or deleting their lock.
      await releaseResources([
        async () => {
          owner.child.kill('SIGKILL')
          await owner.catch(() => undefined)
        },
        () => releaseRecordedProcesses([path.join(cwd, 'alpha.pid')]),
      ])
      const identity = await realpath(cwd)
      await rm(path.join(os.tmpdir(), `matrix-types-${createHash('sha256').update(identity).digest('hex')}.lock`), { recursive: true, force: true })
    })
    await resources.poll(() => access(path.join(cwd, 'alpha.pid')))
    const exited = once(owner.child, 'exit')
    owner.child.kill('SIGKILL')
    await exited
    expect(processExists(Number(await readFile(path.join(cwd, 'alpha.pid'), 'utf8')))).toBe(true)
    const { successor } = await resources.acquire(() => {
      const successor = isolated(cwd, ['build', 'beta'])
      void successor.catch(() => undefined)
      return { successor }
    }, async ({ successor }) => {
      successor.child.kill('SIGTERM')
      await successor.catch(() => undefined)
    })
    await expect(successor).rejects.toThrow('Refusing to recover')
    expect(await readFile(path.join(cwd, 'generated'), 'utf8')).toBe('alpha')
    await writeFile(path.join(cwd, 'release-alpha'), '')
    await owner.catch(() => undefined)
    await resources.dispose()
    expect(await readFile(path.join(cwd, 'observed'), 'utf8')).toBe('alpha')
  })

  it('creates missing host inputs before discovery, collects every context and restores the active build', async () => {
    vi.stubEnv('__MATRIX_TYPE_CONTRACT', 'inherited-invalid-contract')
    const cwd = await workspace()
    for (const product of ['alpha', 'beta', 'alpha']) {
      await runCli(['build', product, '--env', 'staging'])
      const generated = JSON.parse(await readFile(path.join(cwd, 'generated.json'), 'utf8'))
      expect(generated).toMatchObject({ MATRIX_PRODUCT_KEY: product, MATRIX_PRODUCT_VERSION: product === 'alpha' ? '2.0.0' : '3.0.0', MATRIX_PRODUCT_APP_ID: `app.${product}`, MATRIX_TARGET: 'build', NODE_ENV: 'production' })
    }
    const types = await readFile(path.join(cwd, '.matrix/types/matrix-runtime.d.ts'), 'utf8')
    expect(types).toContain('readonly alpha?: string')
    expect(types).toContain('readonly beta?: string')
    const events = (await readFile(path.join(cwd, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(events.filter(event => event.phase === 'target').map(event => event.MATRIX_PRODUCT_KEY)).toEqual(['alpha', 'beta', 'alpha'])
    expect(new Set(events.filter(event => event.phase === 'host').map(event => `${event.MATRIX_PRODUCT_KEY}:${event.MATRIX_TARGET}`)))
      .toEqual(new Set(['alpha:dev', 'alpha:build', 'beta:dev', 'beta:build']))
    await runCli(['prepare', 'alpha', '--env', 'staging'])
    expect(await readFile(path.join(cwd, '.matrix/types/matrix-runtime.d.ts'), 'utf8')).toBe(types)
  })

  it('stops a failed preparation array before host loading and preserves previous declarations', async () => {
    const cwd = await workspace()
    await runCli(['prepare'])
    const output = path.join(cwd, '.matrix/types/matrix-runtime.d.ts')
    const previous = await readFile(output, 'utf8')
    const events = await readFile(path.join(cwd, 'events.jsonl'), 'utf8')
    await writeFile(path.join(cwd, 'prepare.mjs'), 'process.exit(7)')
    await expect(runCli(['build', 'alpha'])).rejects.toThrow('step 1/2')
    expect(await readFile(path.join(cwd, 'events.jsonl'), 'utf8')).toBe(events)
    expect(await readFile(output, 'utf8')).toBe(previous)
  })

  it('holds ownership until the actual target finishes, across independent CLI processes', async (ctx) => {
    const resources = await testResources(ctx.signal, 'matrix-independent-cli-')
    const cwd = await workspace(resources.root)
    await writeFile(path.join(cwd, 'build.mjs'), `
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      import { context } from './context.mjs';
      if (process.env.MATRIX_PRODUCT_KEY === 'alpha') {
        writeFileSync('target-ready', '');
        while (!existsSync('release-target')) await setTimeout(20);
      }
      assert.deepEqual(JSON.parse(readFileSync('generated.json')), context());
    `)
    const start = (product: string, observeContention = false) => resources.acquire(() => {
      const child = isolated(cwd, ['build', product], observeContention)
      void child.catch(() => undefined)
      return { child }
    }, async ({ child }) => {
      await withCleanup(
        () => writeFile(path.join(cwd, 'release-target'), ''),
        async () => {
          child.child.kill('SIGTERM')
          await child.catch(() => undefined)
        },
      )
    })
    const { child: first } = await start('alpha')
    await resources.poll(() => access(path.join(cwd, 'target-ready')), 45_000)
    const { child: second } = await start('beta', true)
    await resources.poll(() => access(path.join(cwd, 'lock-contended')))
    expect(JSON.parse(await readFile(path.join(cwd, 'generated.json'), 'utf8')).MATRIX_PRODUCT_KEY).toBe('alpha')
    await writeFile(path.join(cwd, 'release-target'), '')
    await Promise.all([first, second])
    expect(JSON.parse(await readFile(path.join(cwd, 'generated.json'), 'utf8')).MATRIX_PRODUCT_KEY).toBe('beta')
  })

  it('rejects overlapping continuous contexts instead of overwriting a running service', async () => {
    const cwd = await workspace()
    const config = await readFile(path.join(cwd, 'matrix.config.mjs'), 'utf8')
    await writeFile(path.join(cwd, 'matrix.config.mjs'), config.replace('"web":"web"', '"web":"web","second":"web"'))
    await expect(runCli(['dev', 'alpha'])).rejects.toThrow('Use isolated project roots')
  })

  it('rejects a conflicting build before cleaning the running service output', async () => {
    const cwd = await workspace()
    const filename = path.join(cwd, 'matrix.config.mjs')
    const config = JSON.parse((await readFile(filename, 'utf8')).slice('export default '.length))
    config.projects.web.targets.build = {
      command: 'node build.mjs',
      dependsOn: [{ variant: 'web', target: 'dev', condition: 'ready' }],
      artifacts: {},
    }
    await writeFile(filename, `export default ${JSON.stringify(config)}`)
    await mkdir(path.join(cwd, 'dist'))
    await writeFile(path.join(cwd, 'dist/live-input'), 'keep')
    await expect(runCli(['build', 'alpha'])).rejects.toThrow('Use isolated project roots')
    expect(await readFile(path.join(cwd, 'dist/live-input'), 'utf8')).toBe('keep')
  })
})
