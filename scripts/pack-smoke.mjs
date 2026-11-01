import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { execaSync } from 'execa'
import path from 'pathe'
import { verifyCli } from './pack-cli.mjs'
import { verifyHostCompatibility } from './pack-hosts.mjs'
import { selectCompatibility } from './pack-matrix.mjs'
import { verifyNuxtCompatibility } from './pack-nuxt.mjs'
import { createPackageTimings } from './pack-timings.mjs'
import { verifyViteCompatibility } from './pack-vite.mjs'

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

  let tarball = process.env.TARBALL
  if (tarball) {
    if (!path.isAbsolute(tarball) || !statSync(tarball).isFile())
      throw new Error('TARBALL must be an absolute path to the packed candidate')
  }
  else {
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
    tarball = path.join(packRoot, tarballName)
  }

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

  shutdownVerified = await verifyCli(consumerRoot)
  if (shutdownVerified !== null) {
    await verifyViteCompatibility(tarball, path.join(temporaryRoot, 'vite-workspace'), compatibility, concurrency, timings)
    await verifyHostCompatibility(tarball, path.join(temporaryRoot, 'host-workspace'), compatibility, concurrency, timings)
    await verifyNuxtCompatibility(tarball, path.join(temporaryRoot, 'nuxt-workspace'), compatibility, timings)
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
