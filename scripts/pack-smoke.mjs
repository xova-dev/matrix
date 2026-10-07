import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { execaSync } from 'execa'
import path from 'pathe'
import { verifyHostCompatibility } from './pack-hosts.mjs'
import { selectCompatibility } from './pack-matrix.mjs'
import { createPackageTimings } from './pack-timings.mjs'
import { verifyViteCompatibility } from './pack-vite.mjs'

async function withTimeout(promise, milliseconds, message) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  }
  finally {
    clearTimeout(timeout)
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    if (error.code !== 'ESRCH')
      throw error
    return false
  }
}

function killProcessGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL')
  }
  catch (error) {
    if (error.code !== 'ESRCH')
      throw error
  }
}

async function verifyShutdown(cli, cwd) {
  if (process.platform === 'win32') {
    return false
  }
  mkdirSync(cwd)
  writeFileSync(path.join(cwd, 'matrix.config.json'), JSON.stringify({
    projects: { service: { targets: { dev: 'node service.mjs' } } },
    products: { app: { variants: { first: 'service', second: 'service' } } },
  }))
  writeFileSync(path.join(cwd, 'service.mjs'), [
    'import { renameSync, writeFileSync } from "node:fs";',
    'const name = process.env.MATRIX_VARIANT;',
    'process.once("SIGTERM", () => setTimeout(() => {',
    '  writeFileSync(name + ".closed", "cleaned");',
    '  process.exit(0);',
    '}, 50));',
    'setInterval(() => {}, 1000);',
    'writeFileSync(name + ".pid.tmp", String(process.pid));',
    'renameSync(name + ".pid.tmp", name + ".pid");',
  ].join(String.fromCharCode(10)))

  let stopped = false
  let interruption
  let interrupt
  const interrupted = new Promise((resolve) => {
    interrupt = (signal) => {
      if (interruption)
        return
      interruption = signal
      stopped = true
      resolve()
    }
  })
  const onSigint = () => interrupt('SIGINT')
  const onSigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  try {
    // Own a POSIX process group so failure cleanup includes orphaned descendants.
    const command = spawn(process.execPath, [cli, 'dev', 'app'], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    for (const stream of [command.stdout, command.stderr]) {
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-16_384)
      })
    }
    const exited = once(command, 'exit')
    const closed = once(command, 'close')
    void closed.catch(() => undefined)
    let finished = false
    const markFinished = () => {
      finished = true
    }
    void exited.then(markFinished, markFinished)
    const names = ['first', 'second']
    const verify = async () => {
      while (!names.every(name => existsSync(path.join(cwd, `${name}.pid`)))) {
        if (finished || stopped)
          throw new Error('Packaged CLI stopped before both fixture processes were ready')
        await delay(20)
      }
      if (finished || stopped)
        throw new Error('Packaged CLI stopped before shutdown could be tested')
      const pids = names.map(name => Number(readFileSync(path.join(cwd, `${name}.pid`), 'utf8')))
      // Signal only Matrix: its own executor must stop the fixture processes.
      process.kill(command.pid, 'SIGINT')
      const [code, signal] = await exited
      if (code !== 130 || signal)
        throw new Error('Packaged CLI did not exit with code 130 after SIGINT')
      if (!names.every(name => existsSync(path.join(cwd, `${name}.closed`))) || pids.some(isAlive) || isAlive(-command.pid))
        throw new Error('Packaged CLI exited without fully cleaning up its children')
    }
    try {
      await withTimeout(Promise.race([verify(), interrupted]), 10_000, 'Packaged CLI shutdown timed out')
    }
    catch (error) {
      if (!interruption) {
        if (output)
          console.error(output.trimEnd())
        throw error
      }
    }
    finally {
      stopped = true
      if (command.pid)
        killProcessGroup(command.pid)
      await withTimeout(closed.catch(() => undefined), 2000, 'Smoke process group did not close after cleanup')
    }
  }
  finally {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
  }
  if (interruption) {
    process.exitCode = interruption === 'SIGINT' ? 130 : 143
    return null
  }
  return true
}

const { values } = parseArgs({ options: {
  profile: { type: 'string', default: 'full' },
  concurrency: { type: 'string', default: '2' },
} })
const compatibility = selectCompatibility(values.profile)
const concurrency = Number(values.concurrency)
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
  throw new Error('Package test concurrency must be an integer from 1 to 4')
console.log('Package compatibility:', values.profile, 'concurrency:', concurrency)

const timings = createPackageTimings()
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'xova-matrix-pack-'))
const packageRoot = process.cwd()
const consumerRoot = path.join(temporaryRoot, 'consumer')
const packRoot = path.join(temporaryRoot, 'pack')
const failures = []
let shutdownVerified

try {
  mkdirSync(consumerRoot)
  mkdirSync(packRoot)
  writeFileSync(path.join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'matrix-pack-smoke-consumer',
    private: true,
  }))

  execaSync('pnpm', [
    'pack',
    '--pack-destination',
    packRoot,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
  const tarballName = readdirSync(packRoot).find(name => name.endsWith('.tgz'))
  if (!tarballName)
    throw new Error('pnpm pack did not produce a tarball')
  const tarball = path.join(packRoot, tarballName)

  execaSync('npm', [
    'install',
    '--ignore-scripts',
    '--no-package-lock',
    '--no-save',
    tarball,
  ], {
    cwd: consumerRoot,
    encoding: 'utf8',
  })

  writeFileSync(path.join(consumerRoot, '.env.development'), 'MATRIX_PACK_ROOT=dev-root\n')
  writeFileSync(path.join(consumerRoot, '.env.staging'), 'MATRIX_PACK_ROOT=stage-root\n')
  writeFileSync(path.join(consumerRoot, 'settings.cjs'), 'module.exports = process.env.MATRIX_PACK_ROOT')
  writeFileSync(path.join(consumerRoot, 'settings.mjs'), 'import root from \'./settings.cjs\'; export { root };')
  writeFileSync(path.join(consumerRoot, 'matrix.config.mjs'), `
    import { root } from './settings.mjs';
    setInterval(() => {}, 1000);
    export default {
      envSchema: {
        VITE_ENABLED: { type: 'boolean', default: true },
        VITE_LIMIT: { type: 'number', default: 3 },
        VITE_MODE: { type: 'enum', values: ['remote', 'bundled'], default: 'remote' },
        MAIN_VITE_REQUIRED: { type: 'string' },
      },
      projects: { web: { root, prepare: ['node prepare.mjs'], targets: { build: 'node build.mjs' } } },
      products: { app: { env: { VITE_ENABLED: 'false' }, variants: { web: 'web' } } },
    };
  `)

  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
      const main = await import('@xova/matrix')
      const { createRequire } = await import('node:module')
      const { default: assert } = await import('node:assert/strict')
      for (const host of ['vite', 'rollup', 'webpack', 'esbuild'])
        assert.throws(() => createRequire(import.meta.url).resolve(host), { code: 'MODULE_NOT_FOUND' })
      const config = await import('@xova/matrix/config')
      const plan = await import('@xova/matrix/plan')
      for (const [name, value] of Object.entries({
        'defineMatrixConfig': main.defineMatrixConfig,
        'defineMatrixEnv': main.defineMatrixEnv,
        'createExecutionPlan': main.createExecutionPlan,
        'createPreparationPlan': main.createPreparationPlan,
        'config.defineMatrixConfig': config.defineMatrixConfig,
        'plan.createExecutionPlan': plan.createExecutionPlan,
      })) {
        if (typeof value !== 'function')
          throw new Error(name + ' is not exported as a function')
      }
      delete process.env.MATRIX_PACK_ROOT
      const development = await config.loadMatrixConfig({ envName: 'development' })
      const staging = await config.loadMatrixConfig({ envName: 'staging' })
      if (development.projects.web.root !== 'dev-root' || staging.projects.web.root !== 'stage-root')
        throw new Error('Packaged config worker reused a dependency from another environment')
      const execution = plan.createExecutionPlan({ ...staging, productNames: ['app'], target: 'build' })
      if (execution.tasks[0].env.MATRIX_PACK_ROOT !== 'stage-root' || process.env.MATRIX_PACK_ROOT !== undefined)
        throw new Error('Packaged config worker leaked its environment')
    `,
  ], {
    cwd: consumerRoot,
    encoding: 'utf8',
    timeout: 10_000,
  })

  execFileSync(process.execPath, [
    'node_modules/@xova/matrix/bin/matrix.mjs',
    '--help',
  ], {
    cwd: consumerRoot,
    encoding: 'utf8',
    timeout: 10_000,
  })

  // Native addons from the consumer must unload before its directory is removed.
  execFileSync(process.execPath, [fileURLToPath(new URL('./pack-webpack.mjs', import.meta.url)), consumerRoot], {
    encoding: 'utf8',
    timeout: 30_000,
  })

  for (const root of ['dev-root', 'stage-root']) {
    const projectRoot = path.join(consumerRoot, root)
    mkdirSync(projectRoot)
    writeFileSync(path.join(projectRoot, 'prepare.mjs'), 'import { appendFileSync } from "node:fs"; appendFileSync("prepared", "done;");')
    writeFileSync(path.join(projectRoot, 'build.mjs'), [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import matrix from "@xova/matrix/vite";',
      'if (readFileSync("prepared", "utf8") !== "done;") throw new Error("Preparation did not run once");',
      'if (process.env.VITE_ENABLED !== "false" || process.env.VITE_LIMIT !== "3") throw new Error("Raw env types changed");',
      'const plugin = matrix({ types: false });',
      'const code = await plugin.load("\\0virtual:matrix/runtime");',
      'const { matrix: runtime } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));',
      'if (runtime.config.enabled !== false || runtime.config.limit !== 3 || runtime.config.mode !== "remote") throw new Error("Typed runtime mismatch");',
      'if ("required" in runtime.config) throw new Error("Main-only field exposed to Web");',
      'if (!Object.isFrozen(runtime) || !Object.isFrozen(runtime.product) || !Object.isFrozen(runtime.config)) throw new Error("Runtime snapshot is mutable");',
      'writeFileSync("built", "done");',
    ].join('\n'))
  }
  const cli = 'node_modules/@xova/matrix/bin/matrix.mjs'
  const planned = JSON.parse(execFileSync(process.execPath, [cli, 'plan', 'app', '-t', 'build', '-e', 'staging'], { cwd: consumerRoot, encoding: 'utf8', timeout: 10_000 }))
  if (planned.preparations?.[0]?.beforeTask !== 'app:web:build' || existsSync(path.join(consumerRoot, 'stage-root/prepared')))
    throw new Error('Packaged CLI did not plan preparation without executing it')
  if ('envSchema' in planned || planned.tasks[0].env.VITE_ENABLED !== 'false' || planned.tasks[0].env.VITE_LIMIT !== '3')
    throw new Error('Packaged plan lost defaults or exposed internal schema metadata')
  for (const args of [['build', 'app', '-e', 'staging'], ['prepare', 'app', '-e', 'development']]) {
    execFileSync(process.execPath, [cli, ...args], { cwd: consumerRoot, encoding: 'utf8', timeout: 10_000 })
  }
  if (readFileSync(path.join(consumerRoot, 'stage-root/built'), 'utf8') !== 'done'
    || readFileSync(path.join(consumerRoot, 'dev-root/prepared'), 'utf8') !== 'done;'
    || !existsSync(path.join(consumerRoot, 'dev-root/.matrix/types/matrix-runtime.d.ts'))) {
    throw new Error('Packaged CLI did not complete automatic and explicit preparation')
  }
  const doctorRoot = path.join(consumerRoot, 'doctor')
  mkdirSync(doctorRoot)
  const doctorConfigPath = path.join(doctorRoot, 'matrix.config.mjs')
  const command = 'node -e "require(\'node:fs\').writeFileSync(\'executed\', \'bad\')"'
  const doctorConfig = {
    projects: { app: { prepare: command, targets: { dev: command } } },
    products: { app: { variants: {
      service: 'app',
      consumer: { project: 'app', targets: { dev: { dependsOn: ['service', { variant: 'service', condition: 'completed' }] } } },
    } } },
  }
  writeFileSync(doctorConfigPath, `export default ${JSON.stringify(doctorConfig)}`)
  const doctor = () => execaSync(process.execPath, [path.join(consumerRoot, cli), 'doctor'], {
    cwd: doctorRoot,
    encoding: 'utf8',
    timeout: 10_000,
    reject: false,
    env: { MATRIX_PRODUCT_VERSION: undefined },
  })
  const warningResult = doctor()
  const warningOutput = warningResult.stdout + warningResult.stderr
  if (warningResult.exitCode !== 0 || !warningOutput.includes('no readiness probe') || !warningOutput.includes('continuous task'))
    throw new Error('Packaged doctor did not report warnings with a successful exit')
  writeFileSync(doctorConfigPath, `export default ${JSON.stringify({
    projects: {
      missing: { root: 'missing', targets: {} },
      app: { prepare: command, targets: { build: { command, outputDir: '.', artifacts: {} } } },
    },
    products: { app: { variants: { desktop: 'app' } } },
  })}`)
  const errorResult = doctor()
  const errorOutput = errorResult.stdout + errorResult.stderr
  if (errorResult.exitCode !== 1 || !errorOutput.includes('projects.missing.root') || !errorOutput.includes('projects.app.targets.build.outputDir') || !errorOutput.includes('package version'))
    throw new Error('Packaged doctor did not aggregate static errors with a nonzero exit')
  if (readdirSync(doctorRoot).join(',') !== 'matrix.config.mjs')
    throw new Error('Packaged doctor executed commands or wrote workspace files')

  shutdownVerified = await verifyShutdown(path.join(consumerRoot, cli), path.join(consumerRoot, 'shutdown'))
  if (shutdownVerified !== null) {
    await verifyViteCompatibility(tarball, path.join(temporaryRoot, 'vite-workspace'), compatibility, concurrency, timings)
    await verifyHostCompatibility(tarball, path.join(temporaryRoot, 'host-workspace'), compatibility, concurrency, timings)
  }
}
catch (error) {
  failures.push(error)
}
finally {
  timings.report()
  try {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
  catch (error) {
    failures.push(error)
  }
}
if (failures.length === 1)
  throw failures[0]
if (failures.length > 1)
  throw new AggregateError(failures, 'Package smoke and cleanup both failed')
if (shutdownVerified !== null) {
  console.log(shutdownVerified
    ? 'Package smoke passed: exports, config isolation, preparation, doctor, and POSIX shutdown.'
    : 'Package smoke passed: exports, config isolation, preparation, and doctor. POSIX shutdown skipped on Windows.')
}
