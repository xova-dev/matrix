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
    `,
  ], {
    cwd: consumerRoot,
    stdio: 'inherit',
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
