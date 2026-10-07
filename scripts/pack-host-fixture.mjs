// Copied into each temporary consumer: all host and Matrix imports resolve there.
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const host = process.argv[2]
const { default: matrix } = await import(`@xova/matrix/${host}`)
const root = process.cwd()
const require = createRequire(import.meta.url)
assert.equal(createRequire(import.meta.resolve(`@xova/matrix/${host}`)).resolve(host), require.resolve(host))

async function build(entry, out, inline) {
  const plugin = matrix({ envPrefix: 'APP_', inline })
  await mkdir(out, { recursive: true })
  if (host === 'rollup') {
    const { rollup } = await import('rollup')
    const bundle = await rollup({ input: entry, plugins: [plugin] })
    try {
      await bundle.write({ dir: out, format: 'es', entryFileNames: 'entry.mjs', chunkFileNames: '[name]-[hash].mjs' })
    }
    finally {
      await bundle.close?.()
    }
  }
  else if (host === 'esbuild') {
    const { build } = await import('esbuild')
    await build({ entryPoints: [entry], outdir: out, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', splitting: true, logLevel: 'silent', plugins: [plugin] })
  }
  else {
    const { default: webpack } = await import('webpack')
    const compiler = webpack({ mode: 'production', context: root, entry, target: 'node', output: { path: out, filename: 'entry.cjs', chunkFilename: '[id].cjs', library: { type: 'commonjs2' } }, optimization: { minimize: false }, plugins: [plugin] })
    await new Promise((resolve, reject) => {
      compiler.run((error, stats) => {
        compiler.close((closeError) => {
          if (error || closeError || stats?.hasErrors())
            reject(error ?? closeError ?? new Error(stats.toString({ all: false, errors: true })))
          else resolve()
        })
      })
    })
  }
}

for (const inline of [true, false]) {
  const out = path.join(root, `out-${inline}`)
  await build(path.join(root, 'entry.js'), out, inline)
  const built = await import(pathToFileURL(path.join(out, host === 'webpack' ? 'entry.cjs' : 'entry.mjs')).href)
  assert.deepEqual(host === 'webpack' ? built.default.value : built.value, [false, 3, 'fixture', true, true, true])
  const files = await readdir(out)
  const code = (await Promise.all(files.map(file => readFile(path.join(out, file), 'utf8')))).join('\n')
  assert.doesNotMatch(code, /PRIVATE_SENTINEL/)
  if (inline) {
    assert.equal(files.length, 1)
    assert.doesNotMatch(code, /DEV_ONLY_SENTINEL/)
  }
}

await writeFile(path.join(root, 'invalid.js'), 'import { matrix } from "virtual:matrix/runtime"; matrix.config.limit = 8')
await assert.rejects(build(path.join(root, 'invalid.js'), path.join(root, 'out-invalid'), true), /Matrix snapshot is read-only/)
const declaration = await readFile(path.join(root, '.matrix/types/matrix-runtime.d.ts'), 'utf8')
assert.match(declaration, /readonly enabled: boolean/)
assert.match(declaration, /readonly limit: number/)
assert.doesNotMatch(declaration, /PRIVATE_SENTINEL|APP_PRIVATE/)
