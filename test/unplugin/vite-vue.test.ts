import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire, SourceMap } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { runInNewContext } from 'node:vm'
import vue from '@vitejs/plugin-vue'
import { build, createServer } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { MatrixUnplugin } from '../../src/unplugin/index.js'

const directories: string[] = []
const require = createRequire(import.meta.url)

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(setup: boolean) {
  // Stay under the workspace so real Vue imports resolve normally in dev/SSR.
  const root = await mkdtemp(path.join(process.cwd(), '.matrix-vue-test-'))
  directories.push(root)
  const source = [
    setup ? '<script setup lang="ts">' : '<script lang="ts">',
    'import { matrix as context } from "virtual:matrix/runtime";',
    ...(setup ? [] : ['export default { setup() {']),
    'const label: string = context',
    '  .product.name;',
    'if (context.isDevelopment) globalThis.devReady = import("./dev-only.js");',
    'if (context.isProduction && globalThis.fail) throw new Error("VUE_MAP_SENTINEL");',
    ...(setup ? [] : ['return { label }; } };']),
    '</script>',
    '<template><p class="fixture">{{ label }}</p></template>',
    '<style>.fixture::after { content: "STYLE_SENTINEL matrix.isProduction"; }</style>',
  ].join('\n')
  const raw = '<script>import { matrix } from "virtual:matrix/runtime"; matrix.isProduction = false;</script>'
  await writeFile(path.join(root, 'Component.vue'), source)
  await writeFile(path.join(root, 'Raw.vue'), raw)
  await writeFile(path.join(root, 'entry.js'), 'export { default as component } from "./Component.vue"; export { default as raw } from "./Raw.vue?raw";')
  await writeFile(path.join(root, 'dev-only.js'), 'globalThis.devOnly = "VUE_DEV_ONLY_SENTINEL";')
  return { root, source, raw }
}

it.each([
  { setup: true, ssr: false },
  { setup: false, ssr: false },
  { setup: true, ssr: true },
])('optimizes real Vue SFCs with setup=$setup and ssr=$ssr without touching resources', async ({ setup, ssr }) => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MATRIX_NODE_ENV', 'production')
  vi.stubEnv('MATRIX_PRODUCT_NAME', 'vue-fixture')
  const { root, source, raw } = await fixture(setup)
  const entry = path.join(root, 'entry.js')
  const result = await build({
    root,
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [MatrixUnplugin.vite({ types: false }), vue()],
    build: {
      write: false,
      minify: false,
      sourcemap: true,
      ...(ssr ? { ssr: entry } : { lib: { entry, formats: ['cjs'] as ['cjs'], fileName: () => 'entry.cjs' } }),
      rollupOptions: { external: /^vue(?:\/|$)/, output: { format: 'cjs', entryFileNames: 'entry.cjs' } },
    },
  })
  const output = Array.isArray(result) ? result[0]! : result
  if (!('output' in output))
    throw new Error('Expected Vite build output')
  const chunks = output.output.filter(item => item.type === 'chunk')
  expect(chunks).toHaveLength(1)
  const chunk = chunks[0]!
  expect(chunk.code).not.toContain('VUE_DEV_ONLY_SENTINEL')
  const module = { exports: {} as Record<string, any> }
  runInNewContext(chunk.code, { module, exports: module.exports, require })
  expect(module.exports.raw).toBe(raw)
  expect(await renderToString(createSSRApp(module.exports.component))).toBe('<p class="fixture">vue-fixture</p>')
  if (!ssr) {
    const css = output.output.find(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    expect(css?.type === 'asset' ? css.source : undefined).toContain('STYLE_SENTINEL matrix.isProduction')
  }
  if (!chunk.map)
    throw new Error('Expected Vue sourcemap')
  const marker = 'throw new Error'
  const generated = chunk.code.slice(0, chunk.code.indexOf(marker)).split('\n')
  const original = source.slice(0, source.indexOf(marker)).split('\n')
  const map = new SourceMap(JSON.parse(chunk.map.toString()))
  const mapped = map.findEntry(generated.length - 1, generated.at(-1)!.length)
  expect(mapped).toMatchObject({ originalLine: original.length - 1, originalColumn: original.at(-1)!.length })
  expect('originalSource' in mapped && mapped.originalSource).toMatch(/Component\.vue$/)
  expect(chunk.map.sourcesContent).toContain(source)
})

it('preserves development branches through the real Vue dev/SSR pipeline', async () => {
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubEnv('MATRIX_NODE_ENV', 'development')
  vi.stubEnv('MATRIX_PRODUCT_NAME', 'vue-development')
  const { root, raw } = await fixture(true)
  const server = await createServer({
    root,
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [vue(), MatrixUnplugin.vite({ types: false })],
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  try {
    const module = await server.ssrLoadModule('/entry.js')
    expect(module.raw).toBe(raw)
    expect(await renderToString(createSSRApp(module.component))).toBe('<p class="fixture">vue-development</p>')
    const development = (globalThis as { devReady?: Promise<unknown> }).devReady
    expect(development).toBeInstanceOf(Promise)
    await development
    expect(globalThis).toHaveProperty('devOnly', 'VUE_DEV_ONLY_SENTINEL')
  }
  finally {
    await server.close()
    Reflect.deleteProperty(globalThis, 'devOnly')
    Reflect.deleteProperty(globalThis, 'devReady')
  }
})
