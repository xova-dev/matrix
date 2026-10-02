import type { Plugin } from 'esbuild'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { normalize as normalizeNativePath } from 'node:path'
import process from 'node:process'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import MagicString from 'magic-string'
import path from 'pathe'
import { afterEach, expect, it, vi } from 'vitest'
import { MatrixUnplugin } from '../../src/unplugin/index.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(source: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'matrix-esbuild-transform-')))
  directories.push(root)
  const entry = path.join(root, 'entry.js')
  await writeFile(entry, source)
  return { root, entry }
}

function matrixPlugin(): Plugin {
  vi.stubEnv('NODE_ENV', 'production')
  return MatrixUnplugin.esbuild({ types: false })
}

it.each(['none', 'base64', 'percent', 'external', 'trailing-text', 'ambiguous'])('preserves original locations and content with %s input map', async (encoding) => {
  const source = [
    'import { matrix } from "virtual:matrix/runtime";',
    'if (matrix',
    '  .isDevelopment) import("./missing-dev-only.js");',
    'globalThis.result = matrix.isProduction;',
    'throw new Error("MAP_SENTINEL");',
  ].join('\n')
  const generated = new MagicString(source).prepend('// upstream generated\n// upstream generated\n')
  const map = JSON.stringify({ ...JSON.parse(generated.generateMap({ source: 'original.ts', includeContent: true, hires: true }).toString()), sourceRoot: './sources/' })
  const directive = ['base64', 'trailing-text', 'ambiguous'].includes(encoding)
    ? `//#${encoding === 'ambiguous' ? '  ' : ' '}sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(map).toString('base64')}${encoding === 'trailing-text' ? ' trailing text' : ''}`
    : encoding === 'external'
      ? '//# sourceMappingURL=entry.js.map'
      : `/*# sourceMappingURL=data:application/json,${encodeURIComponent(map)} */`
  const input = encoding === 'none' ? source : `${generated}\n${directive}`
  const { root, entry } = await fixture(input)
  if (encoding === 'external' || encoding === 'ambiguous') {
    // External maps stay with esbuild's loader; no static-inlining guarantee.
    await writeFile(`${entry}.map`, map)
    await writeFile(path.join(root, 'missing-dev-only.js'), 'globalThis.devOnly = true;')
  }
  const outfile = path.join(root, 'out/bundle.cjs')
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', sourcemap: true, logLevel: 'silent', plugins: [matrixPlugin()] })
  const executed = spawnSync(process.execPath, ['--enable-source-maps', outfile], { encoding: 'utf8' })
  expect(executed.status).toBe(1)
  expect(executed.stderr).toContain('MAP_SENTINEL')
  const originalFile = ['none', 'ambiguous'].includes(encoding) ? entry : path.join(root, 'sources/original.ts')
  // Node renders filesystem stack frames using the host's native separators.
  expect(executed.stderr).toContain(`${normalizeNativePath(originalFile)}:${encoding === 'ambiguous' ? 7 : 5}:`)
  const outputMap = JSON.parse(await readFile(`${outfile}.map`, 'utf8'))
  expect(outputMap.sourcesContent).toContain(encoding === 'ambiguous' ? input : source)
})

it.each(['jsx', 'tsx'] as const)('preserves upstream maps when .js uses the %s loader', async (loader) => {
  const source = [
    'import { matrix } from "virtual:matrix/runtime";',
    loader === 'tsx' ? 'const h = (): null => null;' : 'const h = () => null;',
    'globalThis.element = <div />;',
    'if (matrix.isDevelopment) import("./missing-dev-only.js");',
    'globalThis.result = matrix.isProduction;',
    'throw new Error("LOADER_MAP_SENTINEL");',
  ].join('\n')
  const generated = new MagicString(source).prepend('// upstream generated\n// upstream generated\n')
  const map = generated.generateMap({ source: `original.${loader}`, includeContent: true, hires: true })
  const { root, entry } = await fixture(`${generated}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map.toString()).toString('base64')}`)
  const outfile = path.join(root, 'out/bundle.cjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    loader: { '.js': loader },
    jsxFactory: 'h',
    sourcemap: true,
    logLevel: 'silent',
    plugins: [matrixPlugin()],
  })
  const executed = spawnSync(process.execPath, ['--enable-source-maps', outfile], { encoding: 'utf8' })
  expect(executed.status).toBe(1)
  expect(executed.stderr).toContain('LOADER_MAP_SENTINEL')
  expect(executed.stderr).toContain(`${normalizeNativePath(path.join(root, `original.${loader}`))}:6:7`)
  const outputMap = JSON.parse(await readFile(`${outfile}.map`, 'utf8'))
  expect(outputMap.sourcesContent).toContain(source)
})

it('preserves a preceding source loader while optimizing files it does not own', async () => {
  const { root, entry } = await fixture([
    'import { matrix } from "virtual:matrix/runtime";',
    'import { flags } from "./owned.js";',
    'if (matrix.isDevelopment) import("./missing-dev-only.js");',
    'globalThis.result = [matrix.isProduction, flags];',
  ].join('\n'))
  await writeFile(path.join(root, 'owned.js'), 'import { matrix } from "virtual:matrix/runtime"; export const flags = [matrix.isProduction, matrix.isDevelopment];')
  const owner: Plugin = {
    name: 'source-owner',
    setup(build) {
      build.onLoad({ filter: /owned\.js$/, namespace: 'file' }, async args => ({
        contents: `globalThis.customLoaderRan = true;\n${await readFile(args.path, 'utf8')}`,
        loader: 'js',
        resolveDir: path.dirname(args.path),
      }))
    },
  }
  const matrix = matrixPlugin()
  const built = await build({ entryPoints: [entry], bundle: true, write: false, logLevel: 'silent', plugins: [owner, matrix] })
  const context: Record<string, unknown> = {}
  runInNewContext(built.outputFiles[0]!.text, context)
  expect(context.result).toEqual([true, [true, false]])
  // Esbuild stops at the first contents result. Required source loaders must
  // precede Matrix; that file then uses the immutable virtual runtime fallback.
  expect(context.customLoaderRan).toBe(true)
})

it('allows a later source loader to process Matrix reads when inlining is disabled', async () => {
  vi.stubEnv('NODE_ENV', 'production')
  const { entry } = await fixture('import { matrix } from "virtual:matrix/runtime"; globalThis.result = matrix.isProduction;')
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    logLevel: 'silent',
    plugins: [MatrixUnplugin.esbuild({ types: false, inline: false }), {
      name: 'later-source-owner',
      setup(build) {
        build.onLoad({ filter: /entry\.js$/, namespace: 'file' }, async args => ({
          contents: `globalThis.customLoaderRan = true;\n${await readFile(args.path, 'utf8')}`,
          loader: 'js',
          resolveDir: path.dirname(args.path),
        }))
      },
    }],
  })
  const context: Record<string, unknown> = {}
  runInNewContext(built.outputFiles[0]!.text, context)
  expect(context.result).toBe(true)
  expect(context.customLoaderRan).toBe(true)
})

it.each(['suffix', 'attributes'])('leaves %s resources to their source loader', async (kind) => {
  const { root } = await fixture('import { matrix } from "virtual:matrix/runtime"; export default matrix.isProduction;')
  const built = await build({
    stdin: {
      contents: kind === 'suffix'
        ? 'import result from "./entry.js?raw"; globalThis.result = result;'
        : 'import result from "./entry.js" with { type: "text" }; globalThis.result = result;',
      resolveDir: root,
    },
    bundle: true,
    write: false,
    logLevel: 'silent',
    plugins: [matrixPlugin(), {
      name: 'resource-owner',
      setup(build) {
        build.onLoad({ filter: /entry\.js$/, namespace: 'file' }, () => ({ contents: 'export default "owned";', loader: 'js' }))
      },
    }],
  })
  const context: Record<string, unknown> = {}
  runInNewContext(built.outputFiles[0]!.text, context)
  expect(context.result).toBe('owned')
})
