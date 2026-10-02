import type { Plugin } from 'rollup'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { SourceMap } from 'node:module'
import os from 'node:os'
import { runInNewContext } from 'node:vm'
import MagicString from 'magic-string'
import path from 'pathe'
import { rollup } from 'rollup'
import { build as vite } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'
import { MatrixUnplugin } from '../../src/unplugin/index.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it.each(['vite', 'rollup'] as const)('%s composes upstream and Matrix maps back to original positions and content', async (host) => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MATRIX_NODE_ENV', 'production')
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'matrix-sourcemap-')))
  directories.push(root)
  const entry = path.join(root, 'entry.js')
  const outputFile = path.join(root, 'out/entry.cjs')
  const source = [
    'import { matrix } from "virtual:matrix/runtime";',
    'const flag = matrix',
    '  .isProduction;',
    'globalThis.result = flag;',
    '  throw new Error("MAP_SENTINEL");',
  ].join('\n')
  await writeFile(entry, source)

  // This is a real preceding transform, not a mock of Matrix or the host.
  const upstream: Plugin = {
    name: 'upstream-source-map',
    transform(code, id) {
      if (path.normalize(id) !== entry)
        return
      const output = new MagicString(code)
      output.prepend('// generated upstream line one\n// generated upstream line two\n')
      return { code: output.toString(), map: output.generateMap({ source: id, includeContent: true, hires: true }).toString() }
    },
  }
  const built = await (async () => {
    if (host === 'vite') {
      const result = await vite({
        root,
        configFile: false,
        envFile: false,
        publicDir: false,
        logLevel: 'silent',
        plugins: [upstream, MatrixUnplugin.vite({ types: false })],
        build: {
          write: false,
          minify: false,
          sourcemap: true,
          lib: { entry, formats: ['cjs'], fileName: () => 'entry.cjs' },
          outDir: path.dirname(outputFile),
        },
      })
      const output = Array.isArray(result) ? result[0]! : result
      if (!('output' in output))
        throw new Error('Expected Vite output')
      return output
    }
    const bundle = await rollup({ input: entry, plugins: [upstream, MatrixUnplugin.rollup({ types: false })] })
    try {
      return await bundle.generate({ format: 'cjs', file: outputFile, sourcemap: true })
    }
    finally {
      await bundle.close()
    }
  })()
  const chunk = built.output.find(item => item.type === 'chunk' && item.isEntry)!
  if (chunk.type !== 'chunk' || !chunk.map)
    throw new Error('Expected entry chunk with sourcemap')

  const context: Record<string, unknown> = {}
  expect(() => runInNewContext(chunk.code, context)).toThrow('MAP_SENTINEL')
  expect(context.result).toBe(true)
  // No runtime dependency should remain for this entirely static Matrix read.
  expect(Object.keys(chunk.modules).map(id => path.normalize(id))).toEqual([entry])

  const map = new SourceMap(JSON.parse(chunk.map.toString()))
  // Check both the first statement after the collapsed multiline read and a
  // nonzero original column; a line-only map or an uncomposed map cannot pass.
  for (const [token, line, column] of [['globalThis.result', 3, 0], ['throw new Error', 4, 2]] as const) {
    const offset = chunk.code.indexOf(token)
    expect(offset).toBeGreaterThanOrEqual(0)
    const prefix = chunk.code.slice(0, offset).split('\n')
    const mapped = map.findEntry(prefix.length - 1, prefix.at(-1)!.length)
    expect(mapped).toMatchObject({ originalLine: line, originalColumn: column })
    if (!('originalSource' in mapped))
      throw new Error('Expected original source location')
    expect(path.resolve(path.dirname(outputFile), mapped.originalSource)).toBe(entry)
    const sourceIndex = chunk.map.sources.indexOf(mapped.originalSource)
    expect(sourceIndex).toBeGreaterThanOrEqual(0)
    expect(chunk.map.sourcesContent?.[sourceIndex]).toBe(source)
  }
})
