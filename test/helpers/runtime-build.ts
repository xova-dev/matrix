import type { MatrixUnpluginOptions } from '../../src/unplugin/index.js'
import type { RuntimeFixture } from './runtime-fixtures.js'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { deserialize, serialize } from 'node:v8'
import { build as esbuild, transform } from 'esbuild'
import path from 'pathe'
import { rollup } from 'rollup'
import { build as vite } from 'vite'
import webpack from 'webpack'
import { inlineMatrixReads } from '../../src/runtime/transform.js'
import { MatrixUnplugin } from '../../src/unplugin/index.js'
import { referenceRuntime, runtimeId, runtimeSnapshot } from './runtime-fixtures.js'
import { compileWebpack } from './webpack.js'

export const hosts = ['vite', 'rollup', 'esbuild', 'webpack'] as const
export type Host = typeof hosts[number]

interface BuildOptions {
  mode?: 'plugin' | 'reference' | 'shared'
  plugins?: MatrixUnpluginOptions[]
  minify?: boolean
  format?: 'esm' | 'cjs'
}

export interface Observation {
  value: unknown
  error: string | null
  events: unknown[]
}

interface RuntimeBuild {
  files: Array<{ name: string, code: string }>
  code: string
  run: (globals?: Record<string, unknown>) => Promise<Observation>
}

// Real modules in a fresh process: ESM, CJS wrappers, top-level await and lazy
// chunks all run normally. V8 serialization preserves undefined, NaN and -0.
const runner = `
  import { pathToFileURL } from 'node:url';
  import { serialize, deserialize } from 'node:v8';
  Object.assign(globalThis, deserialize(Buffer.from(process.argv[2], 'base64')));
  let value, error = null;
  try {
    await import(pathToFileURL(process.argv[1]).href);
    value = await globalThis.result;
  } catch (caught) { error = caught.name; }
  process.stdout.write('MATRIX_TEST_RESULT:' + serialize({ value, error, events: globalThis.events }).toString('base64'));
`

export function createRuntimeBuilder(): {
  cleanup: () => Promise<void>
  build: (host: Host, fixture: RuntimeFixture, options?: BuildOptions) => Promise<RuntimeBuild>
} {
  const directories: string[] = []
  return {
    async cleanup() {
      await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
    },
    async build(host: Host, fixture: RuntimeFixture, options: BuildOptions = {}) {
      const mode = options.mode ?? 'plugin'
      const cjs = options.format === 'cjs'
      const outputExtension = cjs ? '.cjs' : '.mjs'
      const outputEntry = `entry${outputExtension}`
      const outputChunk = `[name]-[hash]${outputExtension}`
      if (mode === 'shared' && host !== 'esbuild')
        throw new Error('Shared transform semantics use esbuild only to emit executable JavaScript')
      if (host === 'rollup' && options.minify)
        throw new Error('The Rollup fixture has no minifier configured')
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'matrix-conformance-')))
      directories.push(root)
      const entryName = `entry.${fixture.extension ?? 'js'}`
      const entry = path.join(root, entryName)
      const out = path.join(root, 'out')
      const sources = {
        'dev-only.js': 'globalThis.events.push("DEV_ONLY_SENTINEL");',
        ...fixture.files,
        [entryName]: fixture.source,
      }
      for (const [name, source] of Object.entries(sources)) {
        const filename = path.join(root, name)
        await mkdir(path.dirname(filename), { recursive: true })
        const code = `"use strict";\n${source}`
        // Transform raw source, before type erasure; host-only tests cannot
        // prove that the shared transformer itself understands TS wrappers.
        const compiled = mode === 'shared' ? inlineMatrixReads(code, filename, runtimeId, runtimeSnapshot)?.code ?? code : code
        await writeFile(filename, compiled)
      }
      const plugins = (options.plugins ?? [{}]).map(option => ({ ...option, types: false as const }))
      const reference = {
        name: 'reference-snapshot',
        resolveId(id: string) { return id === runtimeId ? '\0reference-snapshot' : undefined },
        load(id: string) { return id === '\0reference-snapshot' ? referenceRuntime : undefined },
      }
      if (host === 'vite') {
        await vite({
          root,
          configFile: false,
          envFile: false,
          publicDir: false,
          logLevel: 'silent',
          oxc: { jsx: { runtime: 'classic' } },
          plugins: mode === 'plugin' ? plugins.map(option => MatrixUnplugin.vite(option)) : [reference],
          build: {
            outDir: out,
            target: 'esnext',
            minify: options.minify ?? false,
            lib: { entry, formats: [cjs ? 'cjs' : 'es'], fileName: () => outputEntry },
            rollupOptions: { treeshake: mode !== 'reference', output: { chunkFileNames: outputChunk } },
          },
        })
      }
      else if (host === 'rollup') {
        const built = await rollup({
          input: entry,
          // Keep the reference's original value/reference semantics. In
          // particular, Rollup can fold delete (true ? obj.x : obj.y) into
          // delete obj.x. The Matrix build still uses normal tree shaking.
          treeshake: mode !== 'reference',
          onwarn(warning, warn) {
            if (warning.code !== 'MODULE_LEVEL_DIRECTIVE')
              warn(warning)
          },
          plugins: [{
            name: 'fixture-typescript',
            async transform(code, id) {
              if (/\.(?:[cm]?ts|[jt]sx)$/.test(id))
                return transform(code, { loader: id.endsWith('.tsx') ? 'tsx' : id.endsWith('.jsx') ? 'jsx' : 'ts', format: 'esm', target: 'esnext', sourcemap: true, sourcefile: id })
            },
          }, ...(mode === 'plugin' ? plugins.map(option => MatrixUnplugin.rollup(option)) : [reference])],
        })
        try {
          await built.write({ dir: out, format: cjs ? 'cjs' : 'es', entryFileNames: outputEntry, chunkFileNames: outputChunk })
        }
        finally { await built.close() }
      }
      else if (host === 'esbuild') {
        await esbuild({
          entryPoints: [entry],
          bundle: true,
          outdir: out,
          outExtension: { '.js': outputExtension },
          platform: 'node',
          format: cjs ? 'cjs' : 'esm',
          splitting: !cjs,
          treeShaking: mode !== 'reference',
          minify: options.minify ?? false,
          logLevel: 'silent',
          plugins: mode === 'plugin'
            ? plugins.map(option => MatrixUnplugin.esbuild(option))
            : [{
                name: reference.name,
                setup(build) {
                  build.onResolve({ filter: /^virtual:matrix\/runtime$/ }, () => ({ path: 'snapshot', namespace: 'reference' }))
                  build.onLoad({ filter: /.*/, namespace: 'reference' }, () => ({ contents: referenceRuntime, loader: 'js' }))
                },
              }],
        })
      }
      else {
        const referenceFile = path.join(root, 'snapshot.js')
        if (mode !== 'plugin')
          await writeFile(referenceFile, referenceRuntime)
        await compileWebpack({
          mode: 'production',
          context: root,
          entry,
          target: 'node22',
          devtool: false,
          experiments: { outputModule: !cjs },
          output: { path: out, filename: outputEntry, chunkFilename: `[name]${outputExtension}`, module: !cjs, chunkFormat: cjs ? 'commonjs' : 'module', chunkLoading: cjs ? 'require' : 'import' },
          optimization: { minimize: options.minify ?? false },
          module: { rules: [{ test: /\.(?:[cm]?ts|[jt]sx)$/, use: [fileURLToPath(new URL('./typescript-loader.cjs', import.meta.url))] }] },
          plugins: mode === 'plugin'
            ? plugins.map(option => MatrixUnplugin.webpack(option))
            : [new webpack.NormalModuleReplacementPlugin(/^virtual:matrix\/runtime$/, referenceFile)],
        })
      }
      const files = await Promise.all((await readdir(out)).filter(name => name.endsWith(outputExtension)).map(async name => ({ name, code: await readFile(path.join(out, name), 'utf8') })))
      return {
        files,
        code: files.map(file => file.code).join('\n'),
        async run(globals: Record<string, unknown> = {}): Promise<Observation> {
          const input = serialize({ key: 'isProduction', events: [], ...globals }).toString('base64')
          const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', runner, path.join(out, outputEntry), input], { timeout: 10_000 })
          const marker = 'MATRIX_TEST_RESULT:'
          const offset = stdout.lastIndexOf(marker)
          if (offset < 0)
            throw new Error(`Missing observation for ${fixture.name}`)
          return deserialize(Buffer.from(stdout.slice(offset + marker.length), 'base64')) as Observation
        },
      }
    },
  }
}
