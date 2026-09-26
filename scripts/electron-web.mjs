import { cp, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

const repository = await realpath(fileURLToPath(new URL('../', import.meta.url)))
const example = path.join(repository, 'examples/electron-web')
const setup = process.argv.includes('--setup')
// Windows temp directories can contain 8.3 aliases, which Vite intentionally rejects.
const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'matrix electron-web-')))
const consumer = setup ? example : path.join(temporaryRoot, 'consumer with spaces')
const controller = new AbortController()
const interrupt = () => controller.abort()
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

async function run(file, args, cwd) {
  return execa(file, args, { cwd, stdio: 'inherit', timeout: 900_000, killDescendants: true, cancelSignal: controller.signal })
}

try {
  if (!setup) {
    const generated = new Set(['node_modules', 'dist', 'release', 'artifacts', '.prepared', '.matrix'])
    await cp(example, consumer, { recursive: true, filter: source => !generated.has(path.basename(source)) && !path.basename(source).startsWith('.matrix-acceptance-') && !path.basename(source).startsWith('.env') })
  }
  await run('pnpm', ['pack', '--pack-destination', temporaryRoot], repository)
  const tarball = (await readdir(temporaryRoot)).find(name => name.endsWith('.tgz'))
  if (!tarball)
    throw new Error('Matrix package was not generated')
  await run('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], consumer)
  // Do not add a source alias or rewrite the example's dependency manifest/lockfile.
  await run('npm', ['install', '--include=dev', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporaryRoot, tarball)], consumer)
  if (setup)
    console.log('Example ready. Run npm run dev:alpha or npm run dev:beta from examples/electron-web.')
  else
    await run(process.execPath, ['scripts/verify.mjs'], consumer)
}
finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  await rm(temporaryRoot, { recursive: true, force: true })
}
