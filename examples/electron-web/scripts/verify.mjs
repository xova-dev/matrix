import assert from 'node:assert/strict'
import { access, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)))
const cli = fileURLToPath(new URL('../bin/matrix.mjs', import.meta.resolve('@xova/matrix')))
const controller = new AbortController()
const interrupt = () => controller.abort()
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// Isolate fixture configuration, while preserving PATH, proxies, and download caches.
for (const key of Object.keys(env)) {
  if (key.startsWith('MATRIX_') || key.startsWith('EXAMPLE_') || key.startsWith('WEB_') || key === 'VITE_API_BASE' || key === 'VITE_PRODUCT_LABEL')
    delete env[key]
}

async function run(file, args, extraEnv = {}) {
  try {
    return await execa(file, args, { cwd: root, env: { ...env, ...extraEnv }, extendEnv: false, all: true, timeout: 180_000, killDescendants: true, cancelSignal: controller.signal })
  }
  catch (error) {
    console.error(error.all ?? error.message)
    throw error
  }
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function preparationCount() {
  try {
    return (await readFile(path.join(root, 'apps/desktop/.prepared/runs.jsonl'), 'utf8')).trim().split(String.fromCharCode(10)).length
  }
  catch (error) {
    if (error.code !== 'ENOENT')
      throw error
    return 0
  }
}

function verifyReport(report, product, environment, packaged) {
  assert.equal(report.packaged, packaged)
  assert.equal(report.metadata.product, product)
  assert.equal(report.metadata.appId, `dev.matrix.${product}`)
  assert.equal(report.runtime.page, product)
  assert.equal(report.runtime.product.key, product)
  assert.equal(report.runtime.environment, environment)
  const suffix = environment === 'production' ? '' : environment === 'development' ? '-dev' : '-staging'
  assert.equal(report.runtime.config.apiBase, `https://${product}${suffix}.example.test`)
}

async function executable(directory, product) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (process.platform === 'darwin' && entry.isDirectory() && entry.name.endsWith('.app')) {
      const binaries = await readdir(path.join(candidate, 'Contents/MacOS'))
      assert.equal(binaries.length, 1)
      return path.join(candidate, 'Contents/MacOS', binaries[0])
    }
    if (entry.isFile() && entry.name === `matrix-${product}${process.platform === 'win32' ? '.exe' : ''}`)
      return candidate
    if (entry.isDirectory()) {
      const found = await executable(candidate, product)
      if (found)
        return found
    }
  }
}

const reports = await mkdtemp(path.join(root, '.matrix-acceptance-'))
try {
  let prepared = await preparationCount()
  await run(process.execPath, [cli, 'prepare'])
  assert.equal(await preparationCount(), ++prepared, 'Shared Desktop must prepare once across both products')
  for (const project of ['web-alpha', 'web-beta', 'desktop'])
    await access(path.join(root, 'apps', project, '.matrix/types/matrix-runtime.d.ts'))

  for (const product of ['alpha', 'beta']) {
    const runDirectory = await mkdtemp(path.join(reports, 'dev-'))
    const output = path.join(runDirectory, 'report.json')
    const alphaPort = await freePort()
    let betaPort = await freePort()
    while (betaPort === alphaPort)
      betaPort = await freePort()
    await run(process.execPath, [cli, 'dev', product, '-v', 'desktop'], {
      EXAMPLE_ALPHA_PORT: String(alphaPort),
      EXAMPLE_BETA_PORT: String(betaPort),
      EXAMPLE_SMOKE_OUTPUT: output,
      EXAMPLE_RUN_DIR: runDirectory,
    })
    verifyReport(JSON.parse(await readFile(output, 'utf8')), product, 'development', false)
    const webPid = Number(await readFile(path.join(runDirectory, `web-${product}.started`), 'utf8'))
    assert.throws(() => process.kill(webPid, 0), 'Web process must stop when the Desktop self-check finishes')
    await assert.rejects(access(path.join(runDirectory, `web-${product === 'alpha' ? 'beta' : 'alpha'}.started`)), { code: 'ENOENT' })
    assert.equal(await preparationCount(), ++prepared)
    console.log(`Development verified: ${product} loads only its Web project and releases its processes.`)
  }

  // Same checkout, shared desktop staging directory, alternating products/environments.
  for (const [product, environment] of [['alpha', 'staging'], ['beta', 'production'], ['alpha', 'production']]) {
    const destination = path.join(root, 'artifacts', product, environment)
    const before = await readdir(destination).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
    await run(process.execPath, [cli, 'build', product, '-v', 'desktop', '-e', environment])
    const created = (await readdir(destination)).filter(name => !before.includes(name))
    assert.equal(created.length, 1, 'Exactly one new Desktop artifact must be delivered')
    const binary = await executable(path.join(destination, created[0]), product)
    assert.ok(binary, 'Unpacked application executable is missing')
    const output = path.join(reports, `${product}-${environment}.json`)
    // Deliberately pass conflicting host values: packaged resources must remain authoritative.
    await run(binary, ['--no-sandbox'], { EXAMPLE_SMOKE_OUTPUT: output, MATRIX_PRODUCT_KEY: 'wrong-product', VITE_API_BASE: 'wrong-api' })
    verifyReport(JSON.parse(await readFile(output, 'utf8')), product, environment, true)
    assert.equal(await preparationCount(), ++prepared)
    console.log(`Packaged application verified: ${product} / ${environment}.`)
  }
}
finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  await rm(reports, { recursive: true, force: true })
}
