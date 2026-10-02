import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { rollup } from 'rollup'
import { build as vite } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'
import webpack from 'webpack'
import { MatrixUnplugin } from '../../src/unplugin/index.js'
import { compileWebpack } from '../helpers/webpack.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

// Vite always sorts Matrix's post hook after this normal plugin, independent
// of registration order. Only the other hosts need both permutations.
it.each((['vite', 'rollup', 'webpack'] as const).flatMap(host => (host === 'vite' ? [true] : [true, false]).map(matrixFirst => ({ host, matrixFirst }))))('$host preserves foreign resources with Matrix first: $matrixFirst', async ({ host, matrixFirst }) => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MATRIX_NODE_ENV', 'production')
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'matrix-host-boundary-')))
  directories.push(root)
  const entry = path.join(root, 'entry.js')
  const payload = 'import { matrix } from "virtual:matrix/runtime"; matrix.isProduction = false;'
  await writeFile(path.join(root, 'payload.js'), payload)
  await writeFile(path.join(root, 'opaque.js'), payload)
  await writeFile(path.join(root, 'data.json'), '{"value":42}')
  await writeFile(path.join(root, 'missing-dev-only.js'), 'globalThis.devOnly = "DEV_ONLY_SENTINEL";')
  await writeFile(path.join(root, 'foreign.js'), 'export const matrix = { isProduction: 7 };')
  await writeFile(entry, [
    'import { matrix } from "virtual:matrix/runtime";',
    'import { matrix as foreign } from "virtual:matrix/runtime-other";',
    'import text from "./payload.js?raw";',
    'import opaque from "./opaque.js";',
    'import data from "./data.json";',
    'foreign.isProduction++;',
    'if (matrix.isDevelopment) import("./missing-dev-only.js");',
    'globalThis.result = [matrix.isProduction, foreign.isProduction, text, opaque, data.value];',
  ].join('\n'))
  let code: string
  if (host === 'webpack') {
    const plugins = [MatrixUnplugin.webpack({ types: false }), new webpack.NormalModuleReplacementPlugin(/^virtual:matrix\/runtime-other$/, path.join(root, 'foreign.js'))]
    await compileWebpack({
      mode: 'production',
      context: root,
      entry,
      target: 'node',
      devtool: false,
      output: { path: path.join(root, 'out'), filename: 'entry.js' },
      optimization: { minimize: false },
      module: { rules: [{ resourceQuery: /raw/, type: 'asset/source' }, { test: /opaque\.js$/, type: 'asset/source' }] },
      plugins: matrixFirst ? plugins : plugins.reverse(),
    })
    code = await readFile(path.join(root, 'out', 'entry.js'), 'utf8')
  }
  else {
    const owner = {
      name: 'foreign-owner',
      resolveId(id: string) {
        if (id === 'virtual:matrix/runtime-other')
          return '\0foreign-module'
        if (host === 'rollup' && (id.endsWith('?raw') || id.endsWith('.json')))
          return path.join(root, id)
      },
      async load(id: string) {
        if (id === path.join(root, 'opaque.js'))
          return `export default ${JSON.stringify(await readFile(id, 'utf8'))};`
        if (id === '\0foreign-module')
          return 'export const matrix = { isProduction: 7 };'
        if (host === 'rollup' && id.endsWith('?raw'))
          return `export default ${JSON.stringify(await readFile(id.slice(0, -4), 'utf8'))};`
        if (host === 'rollup' && id.endsWith('.json'))
          return `export default ${await readFile(id, 'utf8')};`
      },
    }
    if (host === 'rollup') {
      const plugins = [MatrixUnplugin.rollup({ types: false }), owner]
      const built = await rollup({ input: entry, plugins: matrixFirst ? plugins : plugins.reverse() })
      try {
        const output = await built.generate({ format: 'cjs' })
        code = output.output[0]!.code
      }
      finally {
        await built.close()
      }
    }
    else {
      const plugins = [MatrixUnplugin.vite({ types: false }), owner]
      const built = await vite({
        root,
        configFile: false,
        envFile: false,
        publicDir: false,
        logLevel: 'silent',
        plugins: matrixFirst ? plugins : plugins.reverse(),
        build: { write: false, minify: false, lib: { entry, formats: ['cjs'] } },
      })
      const output = Array.isArray(built) ? built[0]! : built
      if (!('output' in output))
        throw new Error('Expected build output')
      code = output.output[0]!.code
    }
  }
  const context: Record<string, unknown> = {}
  runInNewContext(code, context)
  expect(context.result).toEqual([true, 8, payload, payload, 42])
  expect(code).not.toContain('DEV_ONLY_SENTINEL')
})
