import type { Plugin } from 'esbuild'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
import { MatrixUnplugin } from '../src/unplugin.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixture(source: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'matrix-esbuild-boundary-')))
  directories.push(root)
  const entry = path.join(root, 'entry.js')
  await writeFile(entry, source)
  return { root, entry }
}

it.each([true, false])('preserves foreign namespaces with Matrix first: %s', async (matrixFirst) => {
  vi.stubEnv('NODE_ENV', 'production')
  const { entry } = await fixture([
    'import { matrix } from "virtual:matrix/runtime";',
    'import answer from "virtual:other";',
    'if (matrix.isDevelopment) import("./missing-dev-only.js");',
    'globalThis.result = [answer, matrix.isProduction];',
  ].join('\n'))
  const other: Plugin = {
    name: 'other',
    setup(build) {
      build.onResolve({ filter: /^virtual:other$/ }, () => ({ path: 'other.js', namespace: 'other' }))
      build.onLoad({ filter: /.*/, namespace: 'other' }, () => ({ contents: 'export default 42', loader: 'js' }))
    },
  }
  const matrix = MatrixUnplugin.esbuild({ types: false })
  const built = await build({ entryPoints: [entry], bundle: true, write: false, logLevel: 'silent', plugins: matrixFirst ? [matrix, other] : [other, matrix] })
  const context: Record<string, unknown> = {}
  runInNewContext(built.outputFiles[0]!.text, context)
  expect(context.result).toEqual([42, true])
})

it.each([
  'import { matrix } from "virtual:matrix/runtime"; globalThis.result = matrix[globalThis.key];',
  'globalThis.result = "virtual:matrix/runtime";',
])('defers unchanged file modules to later loaders: %s', async (source) => {
  const { entry } = await fixture(source)
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    logLevel: 'silent',
    plugins: [MatrixUnplugin.esbuild({ types: false }), {
      name: 'file-owner',
      setup(build) {
        build.onLoad({ filter: /entry\.js$/, namespace: 'file' }, () => ({ contents: 'globalThis.result = 42;', loader: 'js' }))
      },
    }],
  })
  const context: Record<string, unknown> = {}
  runInNewContext(built.outputFiles[0]!.text, context)
  expect(context.result).toBe(42)
})

it('preserves explicitly configured non-script loaders', async () => {
  const source = 'import { matrix } from "virtual:matrix/runtime"; matrix.isProduction;'
  const { root } = await fixture(source)
  const built = await build({
    stdin: { contents: 'import text from "./entry.js"; globalThis.result = text;', resolveDir: root },
    bundle: true,
    write: false,
    logLevel: 'silent',
    loader: { '.js': 'text' },
    plugins: [MatrixUnplugin.esbuild({ types: false })],
  })
  const context: Record<string, unknown> = {}
  runInNewContext(built.outputFiles[0]!.text, context)
  expect(context.result).toBe(source)
})
