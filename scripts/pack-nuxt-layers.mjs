import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { TarArchive } from 'archiver'
import path from 'pathe'
import { writeFixture as write } from './pack-fixtures.mjs'

async function verifyNuxtExtensionlessSelection(cwd, run) {
  const root = path.join(cwd, 'extensionless-selection')
  write(root, 'package.json', { private: true, type: 'module' })
  write(root, 'matrix.config.mjs', `export default ${JSON.stringify({
    projects: { web: { configFile: 'nuxt.config', targets: { build: 'node control.mjs --ready' } } },
    products: { app: { env: { VITE_SELECTED: 'extensionless-selected' }, variants: { web: 'web' } } },
  })}`)
  write(root, 'nuxt.config', `export default defineNuxtConfig({
    ssr: false, devtools: { enabled: false },
    app: { head: { title: 'extensionless-selected' } },
    modules: ['@xova/matrix/nuxt'],
    nitro: { preset: 'static' },
  })`)
  write(root, 'app/app.vue', '<template><main>Extensionless config</main></template>')
  write(root, 'control.mjs', `
    import assert from 'node:assert/strict'
    import { resolve } from 'node:path'
    import { loadNuxt } from 'nuxt/kit'
    let nuxt
    try {
      nuxt = await loadNuxt({ cwd: process.cwd(), configFile: resolve('nuxt.config'), dev: false, ready: false })
      assert.equal(nuxt.options.app.head.title, 'extensionless-selected')
      if (process.argv.includes('--ready')) await nuxt.ready()
    } finally { await nuxt?.close() }
  `)
  const rejection = /Unknown file extension|No loader|not supported|Cannot find module/i
  const native = await run('extensionless-native-control', ['exec', 'node', 'control.mjs'], root, { rejection, allowSuccess: true })
  if (native.exitCode !== 0) {
    await run('extensionless-native-rejection', ['exec', 'matrix', 'prepare'], root, { rejection })
    assert.equal(existsSync(path.join(root, '.matrix/types/matrix-runtime.d.ts')), false)
    return
  }
  await run('extensionless-load', ['exec', 'matrix', 'build', 'app'], root)
  const output = path.join(root, '.matrix/types/matrix-runtime.d.ts')
  const declaration = readFileSync(output, 'utf8')
  assert.match(declaration, /readonly selected: string/)
}
export async function verifyNuxtLayerSelection(cwd, version, run, verifyMixed) {
  await verifyNuxtExtensionlessSelection(cwd, run)
  const archive = new TarArchive({ gzip: true })
  const chunks = []
  const completed = new Promise((resolve, reject) => {
    archive.on('data', chunk => chunks.push(chunk))
    archive.once('end', resolve)
    archive.once('error', reject)
  })
  archive.append(`export default defineNuxtConfig({
    vite: { plugins: [{ name: 'remote-layer-field', configResolved(config) { config.env.LAYER_REMOTE = config.env.NUXT_PUBLIC_LAYER_REMOTE = 'remote-layer-value' } }] },
  })`, { name: 'layer/nuxt.config.mjs' })
  await archive.finalize()
  await completed
  const tarball = Buffer.concat(chunks)
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    if (request.url !== '/layer.tar.gz') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': tarball.length })
    response.end(request.method === 'HEAD' ? undefined : tarball)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const remote = `http://127.0.0.1:${server.address().port}/layer.tar.gz`
  try {
    await verifyMixed(remote)
    for (const scenario of ['ts-mjs', 'mjs-ts', 'explicit-candidates', 'explicit-outside', 'explicit-symlink']) {
      const root = path.join(cwd, 'layer-selection', scenario)
      const mainExtension = scenario === 'mjs-ts' ? 'mjs' : 'ts'
      const layerExtension = scenario === 'mjs-ts' ? 'ts' : 'mjs'
      const explicit = scenario.startsWith('explicit')
      const configFile = scenario === 'explicit-outside'
        ? '../external/nuxt.config.mjs'
        : scenario === 'explicit-symlink' ? './selected-link/custom.config.mjs' : './nuxt.config.mjs'
      const sourceFile = explicit ? configFile : `nuxt.config.${mainExtension}`
      const config = {
        envSchema: { LAYER_ENABLED: { type: 'boolean' }, LAYER_COUNT: { type: 'number' } },
        projects: { web: {
          ...(explicit && { configFile, ...(scenario === 'explicit-symlink' && { configHost: 'nuxt' }) }),
          targets: { build: 'node load.mjs' },
        } },
        products: { app: { env: { LAYER_ENABLED: 'true', LAYER_COUNT: '9', LAYER_MARKER: 'selected-layer-value', PRIVATE_TOKEN: 'LAYER_PRIVATE_SENTINEL' }, variants: { web: 'web' } } },
      }
      write(root, 'package.json', { private: true, type: 'module' })
      write(root, 'matrix.config.mjs', `export default ${JSON.stringify(config)}`)
      const localLayer = `export default defineNuxtConfig({
        extends: ['../nested'],
        modules: ['@xova/matrix/nuxt'],
        matrix: { envPrefix: 'LAYER_' },
      })`
      write(root, `local/nuxt.config.${layerExtension}`, localLayer)
      write(root, 'nested/nuxt.config.cts', `export default defineNuxtConfig({
        vite: { plugins: [{ name: 'nested-layer-field', configResolved(config) { config.env.LAYER_NESTED = 'nested-layer-value' } }] },
      })`)
      const selected = `import { selection } from './selection.mjs'
      const env = field => ({ vite: { plugins: [{ name: 'root-' + field,
        configResolved(config) { config.env['LAYER_' + field] = field.toLowerCase() + '-env-value' } }] } })
      export default () => defineNuxtConfig({
        ssr: false, devtools: { enabled: false },
        app: { head: { title: selection } },
        $development: env('FIRST'), $production: env('FIRST'),
        $env: { development: env('SECOND'), production: env('SECOND') },
        extends: ['./local', 'matrix-test-layer', ${JSON.stringify(remote)}],
        nitro: { preset: 'static' },
      })`
      const selectionFile = scenario === 'explicit-outside'
        ? '../external/selection.mjs'
        : scenario === 'explicit-symlink' ? 'selected-source/selection.mjs' : 'selection.mjs'
      write(root, selectionFile, 'export const selection = "selected-root-title"')
      if (scenario === 'explicit-symlink') {
        write(root, 'selected-source/custom.config.mjs', selected)
        symlinkSync(path.join(root, 'selected-source'), path.join(root, 'selected-link'), 'junction')
      }
      else {
        write(root, sourceFile, selected)
      }
      if (explicit)
        write(root, 'nuxt.config.ts', 'throw new Error("Unselected root config must not load")')
      // Nuxt must win over a Vite neighbor without evaluating it.
      write(root, 'vite.config.ts', 'throw new Error("Nuxt Vite neighbor must not load")')
      write(root, 'load.mjs', `
        import { loadNuxt } from 'nuxt/kit'
        import { renameSync, writeFileSync, unlinkSync } from 'node:fs'
        import { resolve } from 'node:path'
        import { pathToFileURL } from 'node:url'
        const root = process.cwd()
        const selected = ${JSON.stringify(explicit ? configFile : undefined)}
        const link = selected && selected !== './nuxt.config.mjs'
        // Native control: expose only the selected file under Nuxt's standard name.
        // Re-exporting preserves file-relative imports without file-symlink privileges.
        if (selected) renameSync('nuxt.config.ts', 'unselected-config.saved')
        if (link) writeFileSync('nuxt.config.mjs', 'export { default } from ' + JSON.stringify(pathToFileURL(resolve(selected)).href))
        let nuxt
        try {
          nuxt = await loadNuxt({ cwd: root, dev: false, ready: false })
          await nuxt.ready()
          if (nuxt.options.app.head.title !== 'selected-root-title' || nuxt.options.ssr !== false)
            throw new Error('Native Nuxt selected the wrong root configuration')
        } finally {
          await nuxt?.close()
          if (link) unlinkSync('nuxt.config.mjs')
          if (selected) renameSync('unselected-config.saved', 'nuxt.config.ts')
        }
      `)
      // One automatic collection supplies the contract and Matrix context to native loading.
      await run(`layers-${scenario}-load`, ['exec', 'matrix', 'build', 'app'], root)
      const output = path.join(root, '.matrix/types/matrix-runtime.d.ts')
      const declaration = readFileSync(output, 'utf8')
      for (const field of ['enabled: boolean', 'count: number', 'marker: string', 'nested: string', 'package: string', 'remote: string', 'second: string'])
        assert.ok(declaration.includes(`readonly ${field}`), `${scenario} omitted Layer field ${field}`)
      assert.equal(declaration.includes('readonly first: string'), version === '4.6.3', 'Root env merging must use the selected Nuxt version')
      assert.doesNotMatch(declaration, /LAYER_PRIVATE_SENTINEL|privateToken/)
      write(root, `local/nuxt.config.${layerExtension}`, 'throw new Error("Layer config failure")')
      await run(`layers-${scenario}-failure`, ['exec', 'matrix', 'prepare'], root, { rejection: /Layer config failure/ })
      assert.equal(readFileSync(output, 'utf8'), declaration, 'Failed Layer load replaced declarations')
      if (scenario === 'ts-mjs') {
        write(root, `local/nuxt.config.${layerExtension}`, localLayer)
        write(root, sourceFile, selected.replace(remote, remote.replace('layer.tar.gz', 'missing.tar.gz')))
        await run('layers-remote-failure', ['exec', 'matrix', 'prepare'], root, { rejection: /404|Failed to download|fetch|not found/i })
        assert.equal(readFileSync(output, 'utf8'), declaration, 'Failed remote fetch replaced declarations')
      }
    }
    assert.ok(requests > 0, 'The controlled remote Layer was never fetched')
    console.log(`Package Nuxt Layer/config selection passed: nuxt-${version}`)
  }
  finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
