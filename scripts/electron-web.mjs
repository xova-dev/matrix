import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import path from 'pathe'
import { parse, parseAllDocuments, stringify } from 'yaml'

const repository = await realpath(fileURLToPath(new URL('../', import.meta.url)))
const example = path.join(repository, 'examples/electron-web')
// Windows temp directories can contain 8.3 aliases, which Vite intentionally rejects.
const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'matrix electron-web-')))
const consumer = path.join(temporaryRoot, 'consumer with spaces')
const controller = new AbortController()
const interrupt = () => controller.abort()
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

async function run(file, args, cwd) {
  return execa(file, args, { cwd, stdio: 'inherit', timeout: 900_000, killDescendants: true, cancelSignal: controller.signal })
}

async function prepareLockedConsumer(tarball) {
  // pnpm 12 may store the package-manager lock and dependency lock as separate
  // YAML documents. Project dependency snapshots come from the latter.
  const documents = parseAllDocuments(await readFile(path.join(repository, 'pnpm-lock.yaml'), 'utf8'))
  for (const document of documents)
    assert.equal(document.errors.length, 0, 'Workspace lockfile must be valid YAML')
  const lock = documents.map(document => document.toJS()).find(value => value.importers?.['examples/electron-web'])
  assert.equal(lock?.lockfileVersion, '9.0', 'Review the consumer lock projection when pnpm changes its format')
  const importer = lock.importers['examples/electron-web']
  assert.equal(importer.devDependencies['@xova/matrix'].specifier, 'workspace:*')
  const manifest = JSON.parse(await readFile(path.join(consumer, 'package.json'), 'utf8'))
  const matrixManifest = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'))
  const matrixDependencies = lock.importers['.'].dependencies
  assert.deepEqual(Object.keys(matrixDependencies).sort(), Object.keys(matrixManifest.dependencies).sort())
  const reference = 'file:matrix.tgz'
  const snapshot = `@xova/matrix@${reference}`
  await cp(path.join(temporaryRoot, tarball), path.join(consumer, 'matrix.tgz'))
  manifest.devDependencies['@xova/matrix'] = reference
  importer.devDependencies['@xova/matrix'] = { specifier: reference, version: reference }
  lock.importers = { '.': importer }
  delete lock.catalogs
  lock.packages[snapshot] = {
    resolution: {
      integrity: `sha512-${createHash('sha512').update(await readFile(path.join(consumer, 'matrix.tgz'))).digest('base64')}`,
      tarball: reference,
    },
    version: matrixManifest.version,
    engines: matrixManifest.engines,
    hasBin: true,
  }
  // Keep every registry version, integrity and peer snapshot unchanged. Only
  // the workspace link is replaced; installation must not resolve newer deps.
  lock.snapshots[snapshot] = { dependencies: Object.fromEntries(Object.entries(matrixDependencies).map(([name, dependency]) => [name, dependency.version])) }
  const workspace = parse(await readFile(path.join(repository, 'pnpm-workspace.yaml'), 'utf8'))
  delete workspace.packages
  delete workspace.catalog
  await writeFile(path.join(consumer, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(path.join(consumer, 'pnpm-lock.yaml'), stringify(lock))
  // Preserve the same supply-chain policy and exact approved exceptions.
  await writeFile(path.join(consumer, 'pnpm-workspace.yaml'), stringify(workspace))
}

try {
  const generated = new Set(['node_modules', 'dist', 'release', 'artifacts', '.prepared', '.matrix'])
  await cp(example, consumer, { recursive: true, filter: source => !generated.has(path.basename(source)) && !path.basename(source).startsWith('.matrix-acceptance-') && !path.basename(source).startsWith('.env') })
  await run('pnpm', ['pack', '--pack-destination', temporaryRoot], repository)
  const tarball = (await readdir(temporaryRoot)).find(name => name.endsWith('.tgz'))
  if (!tarball)
    throw new Error('Matrix package was not generated')
  await prepareLockedConsumer(tarball)
  await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], consumer)
  const installed = path.normalize(await realpath(path.join(consumer, 'node_modules/@xova/matrix')))
  assert.ok(installed.startsWith(`${consumer}${path.sep}`), 'Acceptance must use the installed tarball, not the repository')
  await run(process.execPath, ['acceptance/verify.mjs'], consumer)
}
finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  await rm(temporaryRoot, { recursive: true, force: true })
}
