import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire, SourceMap } from 'node:module'
import os from 'node:os'
import { win32 } from 'node:path'
import process from 'node:process'
import MagicString from 'magic-string'
import path from 'pathe'
import { afterEach, expect, it, vi } from 'vitest'
import webpack from 'webpack'
import { createMatrixRuntime } from '../../src/runtime/snapshot.js'
import { MatrixUnplugin } from '../../src/unplugin/index.js'
import transform from '../../src/unplugin/webpack-loader.js'
import { compileWebpack } from '../helpers/webpack.js'

const directories: string[] = []
const require = createRequire(import.meta.url)

it('composes upstream maps for a Windows loader resource on every platform', async () => {
  const resourcePath = win32.join('C:/workspace/app', 'entry.js')
  const source = 'import { matrix } from "virtual:matrix/runtime";\nglobalThis.result = matrix.isProduction;'
  const upstream = new MagicString(source).prepend('// upstream\n// upstream\n')
  const inputMap = JSON.parse(upstream.generateMap({ source: resourcePath, includeContent: true, hires: true }).toString())
  // Only the host callback/options boundary is supplied here; both transforms
  // and Webpack's source-map composition use their real implementations.
  const output = await new Promise<{ code: string, map: ConstructorParameters<typeof SourceMap>[0] }>((resolve, reject) => {
    const context = {
      resourcePath,
      getOptions: () => ({ runtimeId: 'virtual:matrix/runtime', runtime: createMatrixRuntime({ NODE_ENV: 'production' }) }),
      _compiler: { webpack },
      async: () => (error: Error | null, code: string, map: ConstructorParameters<typeof SourceMap>[0]) => {
        if (error)
          reject(error)
        else resolve({ code, map })
      },
    } as unknown as ThisParameterType<typeof transform>
    void transform.call(context, upstream.toString(), inputMap, undefined).catch(reject)
  })
  expect(output.code).toContain('globalThis.result = (true)')
  const prefix = output.code.slice(0, output.code.indexOf('globalThis.result')).split('\n')
  expect(new SourceMap(output.map).findEntry(prefix.length - 1, prefix.at(-1)!.length)).toMatchObject({
    originalSource: 'C:/workspace/app/entry.js',
    originalLine: 1,
    originalColumn: 0,
  })
  expect(output.map.sourcesContent).toContain(source)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'matrix-webpack-transform-')))
  directories.push(root)
  return root
}

it('preserves asset/resource bytes even with a script extension and no Matrix import', async () => {
  const root = await fixture()
  const bytes = Buffer.from([0, 255, 254, 128, 65])
  await writeFile(path.join(root, 'binary.js'), bytes)
  await writeFile(path.join(root, 'entry.js'), 'import asset from "./binary.js"; globalThis.result = asset;')
  await compileWebpack({
    mode: 'production',
    context: root,
    entry: './entry.js',
    target: 'node',
    output: { path: path.join(root, 'out'), filename: 'entry.cjs', assetModuleFilename: 'payload.bin' },
    module: { rules: [{ test: /binary\.js$/, type: 'asset/resource' }] },
    plugins: [MatrixUnplugin.webpack({ types: false })],
  })
  expect(await readFile(path.join(root, 'out/payload.bin'))).toEqual(bytes)
})

it.each([false, true])('preserves original error positions with upstream sourcemap: %s', async (upstream) => {
  vi.stubEnv('NODE_ENV', 'production')
  const root = await fixture()
  const source = [
    'import { matrix } from "virtual:matrix/runtime";',
    'const flag = matrix',
    '  .isProduction;',
    'globalThis.result = flag;',
    '  if (matrix.isProduction) throw new Error("MAP_SENTINEL");',
  ].join('\n')
  await writeFile(path.join(root, 'entry.js'), source)
  // A real upstream loader adds two lines and preserves exact input columns.
  await writeFile(path.join(root, 'upstream.cjs'), [
    `const { default: MagicString } = require(${JSON.stringify(require.resolve('magic-string'))});`,
    'module.exports = function(source) {',
    'const output = new MagicString(source).prepend("// generated\\n// generated\\n");',
    'this.callback(null, output.toString(), JSON.parse(output.generateMap({',
    'source: this.resourcePath, includeContent: true, hires: true',
    '}).toString())); };',
  ].join('\n'))
  await compileWebpack({
    mode: 'production',
    context: root,
    entry: './entry.js',
    target: 'node',
    devtool: 'source-map',
    optimization: { minimize: false },
    output: { path: path.join(root, 'out'), filename: 'entry.cjs' },
    module: { rules: upstream ? [{ test: /entry\.js$/, use: [path.join(root, 'upstream.cjs')] }] : [] },
    plugins: [MatrixUnplugin.webpack({ types: false })],
  })
  const executed = spawnSync(process.execPath, ['--enable-source-maps', path.join(root, 'out/entry.cjs')], { encoding: 'utf8' })
  expect(executed.status).toBe(1)
  expect(executed.stderr).toContain('MAP_SENTINEL')
  const originalColumn = source.split('\n')[4]!.indexOf('new Error') + 1
  expect(executed.stderr).toContain(`entry.js:5:${originalColumn})`)
  const map = JSON.parse(await readFile(path.join(root, 'out/entry.cjs.map'), 'utf8'))
  expect(map.sourcesContent).toContain(source)
})
