import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'xova-matrix-pack-'))
const packageRoot = process.cwd()
const consumerRoot = path.join(temporaryRoot, 'consumer')
const packRoot = path.join(temporaryRoot, 'pack')
mkdirSync(consumerRoot)
mkdirSync(packRoot)

try {
  writeFileSync(path.join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'matrix-pack-smoke-consumer',
    private: true,
  }))

  execFileSync('pnpm', [
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

  execFileSync('npm', [
    'install',
    '--ignore-scripts',
    '--no-package-lock',
    '--no-save',
    tarball,
  ], {
    cwd: consumerRoot,
    stdio: 'inherit',
  })

  writeFileSync(path.join(consumerRoot, '.env.development'), 'MATRIX_PACK_ROOT=dev-root\n')
  writeFileSync(path.join(consumerRoot, '.env.staging'), 'MATRIX_PACK_ROOT=stage-root\n')
  writeFileSync(path.join(consumerRoot, 'settings.cjs'), 'module.exports = process.env.MATRIX_PACK_ROOT')
  writeFileSync(path.join(consumerRoot, 'settings.mjs'), 'import root from \'./settings.cjs\'; export { root };')
  writeFileSync(path.join(consumerRoot, 'matrix.config.mjs'), `
    import { root } from './settings.mjs';
    setInterval(() => {}, 1000);
    export default {
      projects: { web: { root, targets: { build: 'echo build' } } },
      products: { app: { variants: { web: 'web' } } },
    };
  `)

  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
      const main = await import('@xova/matrix')
      const config = await import('@xova/matrix/config')
      const plan = await import('@xova/matrix/plan')
      for (const [name, value] of Object.entries({
        'defineMatrixConfig': main.defineMatrixConfig,
        'defineMatrixEnv': main.defineMatrixEnv,
        'createExecutionPlan': main.createExecutionPlan,
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
    stdio: 'inherit',
    timeout: 10_000,
  })

  execFileSync(process.execPath, [
    'node_modules/@xova/matrix/bin/matrix.mjs',
    '--help',
  ], {
    cwd: consumerRoot,
    stdio: 'inherit',
  })
}
finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
