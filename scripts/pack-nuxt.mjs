import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import { delimiter } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { TarArchive } from 'archiver'
import { execa } from 'execa'
import path from 'pathe'
import { fixtureCode as code, expectFailure, fixtureFiles, writeFixture as write } from './pack-fixtures.mjs'

async function freePort() {
  const reservation = net.createServer()
  await new Promise((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const { port } = reservation.address()
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  return port
}

async function withServer(command, args, options, verify) {
  const port = await freePort()
  const child = execa(command, args, { ...options, env: { ...options.env, PORT: String(port), NUXT_PORT: String(port), NUXT_HOST: '127.0.0.1', HOST: '127.0.0.1' }, all: true })
  const completion = child.catch(error => error)
  let stopped = false
  let diagnostic = ''
  child.all?.on('data', chunk => diagnostic += chunk.toString())
  void completion.then((result) => {
    stopped = true
    diagnostic = result.all ?? ''
  })
  try {
    const origin = `http://127.0.0.1:${port}`
    let response
    const until = Date.now() + 60_000
    while (Date.now() < until) {
      if (stopped)
        break
      response = await fetch(origin, { signal: AbortSignal.timeout(2000) }).catch(() => undefined)
      if (response?.ok)
        break
      await delay(100)
    }
    assert.ok(response?.ok, `Nuxt server failed to start: ${diagnostic}`)
    await verify(origin, response)
  }
  finally {
    child.kill('SIGTERM')
    await completion
  }
}

async function verifyNodeOutput(root, project, product) {
  const output = path.join(project, '.output')
  const fingerprint = () => {
    const hash = createHash('sha256')
    for (const file of fixtureFiles(output).sort())
      hash.update(path.relative(output, file)).update('\0').update(readFileSync(file))
    return hash.digest('hex')
  }
  const before = fingerprint()
  for (const name of ['first', 'second']) {
    const apiBase = `${name}-deployment`
    const env = { ...process.env, NUXT_PUBLIC_API_BASE: apiBase, NUXT_PUBLIC_NATIVE_API: apiBase, NUXT_PUBLIC_MATRIX_API: 'DEPLOYMENT_MUST_NOT_CHANGE_SNAPSHOT', NUXT_PRIVATE_TOKEN: `${name}-private-deployment` }
    for (const key of Object.keys(env)) {
      if (key.startsWith('MATRIX_') || key.startsWith('__MATRIX_'))
        delete env[key]
    }
    await withServer(process.execPath, ['.output/server/index.mjs'], { cwd: project, env, extendEnv: false }, async (origin, response) => {
      const html = await response.text()
      assert.match(html, new RegExp(apiBase))
      assert.doesNotMatch(html, /private-deployment|PRIVATE_BUILD_SENTINEL/)
      if (product) {
        assert.match(html, new RegExp(`${product}-snapshot`))
        assert.match(html, /late-field/)
        assert.doesNotMatch(html, /DEPLOYMENT_MUST_NOT_CHANGE_SNAPSHOT|MIXED_PRIVATE_SENTINEL|MIXED_APP_SENTINEL|__MATRIX_TYPE_CONTRACT|__MATRIX_ENV_SCHEMA/)
        assert.equal(response.headers.get('x-matrix-snapshot'), `${product}-snapshot`, 'Nitro plugin must share the app snapshot')
      }
      for (const asset of new Set([...html.matchAll(/(?:src|href)="(\/_nuxt\/[^"]+)"/g)].map(match => match[1]))) {
        const assetResponse = await fetch(`${origin}${asset}`, { signal: AbortSignal.timeout(10_000) })
        assert.ok(assetResponse.ok, `Nitro failed to serve client asset ${asset}: ${assetResponse.status}`)
        await assetResponse.arrayBuffer()
      }
      const server = await (await fetch(`${origin}/api/config`)).json()
      assert.deepEqual(server, { apiBase, privatePresent: true, privateMatched: true, ...(product ? { snapshot: `${product}-snapshot`, enabled: true, late: 'late-field' } : {}) })
      const next = await (await fetch(`${origin}/next`)).text()
      assert.match(next, new RegExp(apiBase))
      if (product)
        assert.match(next, new RegExp(`${product}-snapshot`))
    })
  }
  assert.equal(fingerprint(), before, 'Deployment overrides must not rebuild or mutate the artifact')
  assert.equal(existsSync(path.join(root, '.matrix')), false)
}

export async function verifyMixedNuxt(cwd, version, run) {
  const workspace = path.join(cwd, 'mixed')
  const root = path.join(workspace, 'apps/main')
  const second = path.join(workspace, 'apps/second')
  write(workspace, 'package.json', { private: true, type: 'module' })
  const matrixConfig = {
    envSchema: {
      NUXT_PUBLIC_ENABLED: { type: 'boolean', default: true },
      VITE_TYPED_COUNT: { type: 'number' },
    },
    projects: {
      web: { root: 'apps/main', targets: { dev: 'nuxt dev', build: 'nuxt build' } },
      secondary: { root: 'apps/second', targets: { dev: 'nuxt dev', build: 'nuxt generate' } },
    },
    products: Object.fromEntries(['alpha', 'beta'].map(name => [name, {
      env: {
        NUXT_PUBLIC_MATRIX_API: `${name}-snapshot`,
        NUXT_PUBLIC_NATIVE_API: `${name}-native`,
        VITE_COMPAT_LABEL: `${name}-vite`,
        VITE_TYPED_COUNT: '7',
        [`NUXT_PUBLIC_${name.toUpperCase()}_ONLY`]: 'present',
        NUXT_PRIVATE_TOKEN: 'MIXED_PRIVATE_SENTINEL',
        APP_PRIVATE: 'MIXED_APP_SENTINEL',
        APP_PUBLIC_CUSTOM_LABEL: `${name}-custom`,
      },
      variants: { web: 'web', second: 'secondary' },
    }])),
  }
  write(workspace, 'matrix.config.mjs', `export default ${JSON.stringify(matrixConfig)}`)
  write(second, 'nuxt.config.ts', `export default defineNuxtConfig({
    ssr: false,
    modules: ['@xova/matrix/nuxt'],
    matrix: { envPrefix: 'APP_PUBLIC_' },
    devtools: { enabled: false },
  })`)
  write(second, 'app/app.vue', '<template><NuxtPage /></template>')
  write(second, 'app/pages/index.vue', `<script setup lang="ts">
    import { matrix } from 'virtual:matrix/runtime'
    const count = ref(0)
  </script><template><main><p id="snapshot">{{ matrix.config.customLabel }}</p>
    <button id="increment" @click="count++">Count {{ count }}</button><NuxtLink id="next" to="/next">Next</NuxtLink></main></template>`)
  write(second, 'app/pages/next.vue', `<script setup lang="ts">import { matrix } from 'virtual:matrix/runtime'</script>
    <template><main><p id="snapshot">{{ matrix.config.customLabel }}</p><NuxtLink to="/">Home</NuxtLink></main></template>`)
  write(second, 'tsconfig.json', { extends: './.nuxt/tsconfig.json' })
  const moduleOptions = { scope: 'web', types: { output: 'types/snapshot.d.ts' } }
  const runtimeOnlyOptions = JSON.stringify({ scope: 'web', types: false })
  write(cwd, 'mixed-layer/nuxt.config.ts', `export default defineNuxtConfig({
    modules: [['@xova/matrix/nuxt', ${JSON.stringify(moduleOptions)}]],
    nitro: { preset: 'node-server' },
    runtimeConfig: { privateToken: '', public: { nativeApi: '' } },
  })`)
  write(root, 'nuxt.config.ts', `export default defineNuxtConfig({
    ssr: true,
    srcDir: 'src',
    extends: ['../../../mixed-layer'],
    modules: [['@xova/matrix/nuxt', ${JSON.stringify(moduleOptions)}]],
    devtools: { enabled: false },
    hooks: {
      'vite:configResolved'(config) {
        config.plugins?.push({
          name: 'late-nuxt-config',
          configResolved(resolved) { resolved.env.NUXT_PUBLIC_LATE_FIELD = 'late-field' },
        })
      },
    },
  })`)
  write(root, 'src/app.vue', '<template><NuxtPage /></template>')
  write(root, 'src/pages/index.vue', `<script setup lang="ts">
    import { matrix } from 'virtual:matrix/runtime/web'
    const native = useRuntimeConfig()
    const count = ref(0)
    const enabled: boolean = matrix.config.enabled
    const typedCount: number = matrix.config.typedCount
    const rawCount: string = import.meta.env.VITE_TYPED_COUNT
    const optional: string | undefined = matrix.config.alphaOnly
  </script>
  <template><main><h1>Mixed Nuxt</h1><p id="snapshot">{{ matrix.config.matrixApi }}</p>
  <p id="native">{{ native.public.nativeApi }}</p><p id="enabled">{{ enabled }}</p>
  <p id="compat">{{ matrix.config.compatLabel }}</p><p id="typed">{{ typedCount }}:{{ rawCount }}</p>
  <p id="late">{{ matrix.config.lateField }}</p><p id="optional">{{ optional }}</p>
  <button id="increment" @click="count++">Count {{ count }}</button>
  <NuxtLink id="next" to="/next">Next page</NuxtLink></main></template>`)
  write(root, 'src/pages/next.vue', `<script setup lang="ts">import { matrix } from 'virtual:matrix/runtime/web'</script>
    <template><main><h1>Next mixed page</h1><p id="snapshot">{{ matrix.config.matrixApi }}</p><p>{{ useRuntimeConfig().public.nativeApi }}</p><NuxtLink to="/">Home</NuxtLink></main></template>`)
  write(root, 'server/api/config.get.ts', `import { matrix } from 'virtual:matrix/runtime/web'
    export default defineEventHandler((event) => {
      const config = useRuntimeConfig(event)
      if ('compatLabel' in config.public || 'typedCount' in config.public)
        throw new Error('Matrix must not synthesize native runtimeConfig fields')
      return { apiBase: config.public.nativeApi, privatePresent: Boolean(config.privateToken),
        privateMatched: config.privateToken === process.env.NUXT_PRIVATE_TOKEN,
        snapshot: matrix.config.matrixApi, enabled: matrix.config.enabled, late: matrix.config.lateField }
    })`)
  write(root, 'server/plugins/snapshot.ts', `import { matrix } from 'virtual:matrix/runtime/web'
    export default defineNitroPlugin((nitro) => {
      nitro.hooks.hook('request', (event) => event.node.res.setHeader('x-matrix-snapshot', matrix.config.matrixApi))
    })`)
  write(root, 'tsconfig.json', { extends: './.nuxt/tsconfig.json' })
  await run('mixed-prepare', ['exec', 'matrix', 'prepare'], workspace)
  const output = path.join(root, 'types/snapshot.d.ts')
  const declaration = readFileSync(output, 'utf8')
  for (const field of ['alphaOnly?: string', 'betaOnly?: string', 'enabled: boolean', 'lateField: string', 'compatLabel: string', 'typedCount: number', 'VITE_TYPED_COUNT: string'])
    assert.ok(declaration.includes(`readonly ${field}`), `Nuxt declaration missing ${field}`)
  assert.doesNotMatch(declaration, /MIXED_PRIVATE_SENTINEL|PRIVATE_TOKEN|APP_PRIVATE|MIXED_APP_SENTINEL/)
  const secondary = readFileSync(path.join(second, '.matrix/types/matrix-runtime.d.ts'), 'utf8')
  assert.match(secondary, /readonly customLabel: string/)
  assert.doesNotMatch(secondary, /matrixApi|nativeApi|NUXT_PUBLIC_|VITE_|compatLabel|typedCount|appPrivate/)
  assert.equal(existsSync(path.join(root, 'src/.matrix')), false, 'srcDir must not own another declaration')
  assert.equal(existsSync(path.join(root, '.matrix/types')), false, 'custom output must be the only declaration')
  write(root, 'matrix-contract.ts', `import { matrix } from 'virtual:matrix/runtime/web'
    const enabled: boolean = matrix.config.enabled
    const count: number = matrix.config.typedCount
    declare const raw: ImportMetaEnv
    const rawCount: string = raw.VITE_TYPED_COUNT
    const compat: string = matrix.config.compatLabel
    const optional: string | undefined = matrix.config.alphaOnly
    // @ts-expect-error product-specific inferred fields are not always present
    const required: string = matrix.config.alphaOnly
    // @ts-expect-error private fields are not public
    matrix.config.privateToken
    // @ts-expect-error snapshots are immutable
    matrix.config.enabled = false
    void [enabled, optional, required, count, rawCount, compat]
  `)
  write(root, 'tsconfig.matrix.json', {
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: false, noEmit: true, types: [] },
    files: ['matrix-contract.ts', 'types/snapshot.d.ts'],
  })
  await run('mixed-contract-types', ['exec', 'tsc', '-p', 'tsconfig.matrix.json'], root)
  await run('mixed-types', ['exec', 'nuxt', 'typecheck'], root)
  await run('mixed-second-types', ['exec', 'nuxt', 'typecheck'], second)
  await withServer(process.execPath, [path.join(cwd, 'node_modules/@xova/matrix/bin/matrix.mjs'), 'dev', 'alpha', '--variant', 'web'], {
    cwd: workspace,
    env: { PATH: `${path.join(cwd, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}` },
  }, async (origin, response) => {
    const html = await response.text()
    assert.match(html, /alpha-snapshot/)
    assert.match(html, /alpha-vite/)
    assert.match(html, /7:7/)
    assert.equal(response.headers.get('x-matrix-snapshot'), 'alpha-snapshot')
    const config = await (await fetch(`${origin}/api/config`)).json()
    assert.deepEqual(config, { apiBase: 'alpha-native', privatePresent: true, privateMatched: true, snapshot: 'alpha-snapshot', enabled: true, late: 'late-field' })
    assert.equal(readFileSync(output, 'utf8'), declaration, 'Development rewrote the shared type contract')
  })
  for (const product of ['alpha', 'beta']) {
    await run(`mixed-${product}`, ['exec', 'matrix', 'build', product, '--variant', 'web'], workspace)
    assert.equal(readFileSync(output, 'utf8'), declaration, 'Active product overwrote the complete type contract')
    const bundle = code(path.join(root, '.output'))
    assert.match(bundle, new RegExp(`${product}-snapshot`))
    assert.match(bundle, new RegExp(`${product}-native`))
    assert.match(bundle, new RegExp(`${product}-vite`))
    assert.match(bundle, /late-field/)
    assert.doesNotMatch(bundle, new RegExp(`${product === 'alpha' ? 'beta' : 'alpha'}-snapshot|MIXED_PRIVATE_SENTINEL|MIXED_APP_SENTINEL|__MATRIX_TYPE_CONTRACT|__MATRIX_ENV_SCHEMA`))
    await verifyNodeOutput(workspace, root, product)
  }
  // Nuxt's default NUXT_ Vite prefix must not expose private business fields.
  assert.doesNotMatch(declaration, /privateToken|appPrivate/)
  await run('mixed-second-build', ['exec', 'matrix', 'build', 'alpha', '--variant', 'second'], workspace)
  assert.match(code(path.join(second, '.output/public')), /alpha-custom/)
  assert.doesNotMatch(code(path.join(second, '.output/public')), /MIXED_PRIVATE_SENTINEL|MIXED_APP_SENTINEL|alpha-snapshot|alpha-vite/)
  const configFile = path.join(root, 'nuxt.config.ts')
  const config = readFileSync(configFile, 'utf8')
  const runtimeOnlyConfig = config.replace(JSON.stringify(moduleOptions), runtimeOnlyOptions)
  const layerFile = path.join(cwd, 'mixed-layer/nuxt.config.ts')
  const layer = readFileSync(layerFile, 'utf8')
  const fails = (phase, args, pattern) => expectFailure(run(phase, args, args[1] === 'matrix' ? workspace : root), pattern, phase)
  const restoreHostConfigs = () => {
    write(root, 'nuxt.config.ts', config)
    write(cwd, 'mixed-layer/nuxt.config.ts', layer)
  }
  try {
    for (const [name, mutate, expectedKeys] of [
      ['different-values', () => { matrixConfig.products.alpha.env.VITE_MATRIX_API = 'COLLISION_PRIVATE_VALUE' }, ['NUXT_PUBLIC_MATRIX_API', 'VITE_MATRIX_API']],
      ['same-values', () => { matrixConfig.products.alpha.env.VITE_MATRIX_API = 'alpha-snapshot' }, ['NUXT_PUBLIC_MATRIX_API', 'VITE_MATRIX_API']],
      ['camel-case', () => { matrixConfig.products.alpha.env.NUXT_PUBLIC_MATRIX__API = 'COLLISION_PRIVATE_VALUE' }, ['NUXT_PUBLIC_MATRIX_API', 'NUXT_PUBLIC_MATRIX__API']],
      ['cross-product', () => {
        delete matrixConfig.products.beta.env.NUXT_PUBLIC_MATRIX_API
        matrixConfig.products.beta.env.VITE_MATRIX_API = 'COLLISION_PRIVATE_VALUE'
      }, ['NUXT_PUBLIC_MATRIX_API', 'VITE_MATRIX_API']],
      ['schema', () => { matrixConfig.envSchema.NUXT_PUBLIC_TYPED_COUNT = { type: 'number', optional: true } }, ['NUXT_PUBLIC_TYPED_COUNT', 'VITE_TYPED_COUNT']],
    ]) {
      const original = JSON.stringify(matrixConfig)
      try {
        mutate()
        write(workspace, 'matrix.config.mjs', `export default ${JSON.stringify(matrixConfig)}`)
        const diagnostic = await fails(`mixed-collision-${name}`, ['exec', 'matrix', 'prepare'], /both map to matrix\.config\.(?:matrixApi|typedCount)/)
        for (const key of expectedKeys)
          assert.ok(diagnostic.includes(key), `${name} diagnostic omitted ${key}`)
        assert.doesNotMatch(diagnostic, /COLLISION_PRIVATE_VALUE/)
        assert.equal(readFileSync(output, 'utf8'), declaration, 'Failed collection replaced the valid declarations')
      }
      finally {
        Object.assign(matrixConfig, JSON.parse(original))
        write(workspace, 'matrix.config.mjs', `export default ${JSON.stringify(matrixConfig)}`)
      }
    }
    write(root, 'nuxt.config.ts', `import matrix from '@xova/matrix/vite';\n${config.replace('ssr: true,', 'ssr: true, vite: { plugins: [matrix({ types: false })] },')}`)
    await fails('mixed-duplicate-rejected', ['exec', 'matrix', 'prepare', 'alpha'], /remove the manual Matrix Vite plugin/)
    write(root, 'nuxt.config.ts', config)
    matrixConfig.projects.web.typegen = false
    write(workspace, 'matrix.config.mjs', `export default ${JSON.stringify(matrixConfig)}`)
    await fails('mixed-project-types-rejected', ['exec', 'matrix', 'build', 'alpha', '--variant', 'web'], /also set the Nuxt module option types:false/)
    write(root, 'nuxt.config.ts', runtimeOnlyConfig)
    write(cwd, 'mixed-layer/nuxt.config.ts', layer.replace(JSON.stringify(moduleOptions), runtimeOnlyOptions))
    await run('mixed-runtime-only', ['exec', 'matrix', 'build', 'alpha', '--variant', 'web'], workspace)
    assert.equal(readFileSync(output, 'utf8'), declaration, 'runtime-only integration must not rewrite declarations')
    matrixConfig.products.alpha.env.VITE_MATRIX_API = 'COLLISION_PRIVATE_VALUE'
    write(workspace, 'matrix.config.mjs', `export default ${JSON.stringify(matrixConfig)}`)
    await fails('mixed-runtime-collision-rejected', ['exec', 'matrix', 'build', 'alpha', '--variant', 'web'], /NUXT_PUBLIC_MATRIX_API and VITE_MATRIX_API: both map to matrix.config.matrixApi/)
    delete matrixConfig.products.alpha.env.VITE_MATRIX_API
    write(workspace, 'matrix.config.mjs', `export default ${JSON.stringify(matrixConfig)}`)
    for (const [name, mutation] of [
      ['values', 'resolved.env.NUXT_PUBLIC_MATRIX_API = \'server-diverged\''],
      ['prefixes', 'resolved.envPrefix = [\'SERVER_PUBLIC_\', \'MATRIX_\']'],
    ]) {
      write(root, 'nuxt.config.ts', runtimeOnlyConfig.replace('configResolved(resolved) {', `configResolved(resolved) { if (resolved.build.ssr) { ${mutation} };`))
      await fails(`mixed-server-${name}-rejected`, ['exec', 'matrix', 'build', 'alpha', '--variant', 'web'], /client\/server public snapshots differ/)
    }
    write(root, 'nuxt.config.ts', runtimeOnlyConfig.replace('devtools:', 'nitro: { preset: \'cloudflare\' }, devtools:'))
    await fails('mixed-nitro-preset-rejected', ['exec', 'matrix', 'build', 'alpha', '--variant', 'web'], /direct Nitro imports support only the node-server preset/)
    write(root, 'nuxt.config.ts', runtimeOnlyConfig.replace('ssr: true,', 'ssr: true, experimental: { viteEnvironmentApi: true },'))
    await fails('mixed-runtime-only-environment-api-rejected', ['exec', 'nuxt', 'prepare'], /does not support experimental.viteEnvironmentApi/)
    restoreHostConfigs()
    await fails('mixed-no-context-rejected', ['exec', 'nuxt', 'build'], /no product context/)
  }
  finally {
    restoreHostConfigs()
    delete matrixConfig.projects.web.typegen
    write(workspace, 'matrix.config.mjs', `export default ${JSON.stringify(matrixConfig)}`)
  }
  console.log(`Package mixed Nuxt SSR/SPA and Node Nitro integration passed: nuxt-${version}`)
}

async function verifyNuxtExtensionlessSelection(cwd, run) {
  const root = path.join(cwd, 'extensionless-selection')
  write(root, 'package.json', { private: true, type: 'module' })
  write(root, 'matrix.config.mjs', `export default ${JSON.stringify({
    projects: { web: { configFile: 'nuxt.config', targets: { build: 'node control.mjs build' } } },
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
    import { loadNuxt, buildNuxt } from 'nuxt/kit'
    let nuxt
    try {
      nuxt = await loadNuxt({ cwd: process.cwd(), configFile: resolve('nuxt.config'), dev: false, ready: false })
      assert.equal(nuxt.options.app.head.title, 'extensionless-selected')
      if (process.argv[2] === 'build') {
        await nuxt.ready()
        await buildNuxt(nuxt)
      }
    } finally { await nuxt?.close() }
  `)
  const native = await run('extensionless-native-control', ['exec', 'node', 'control.mjs'], root).catch(error => error)
  if (native.exitCode !== 0) {
    assert.match(`${native.stdout ?? ''}\n${native.stderr ?? ''}`, /Unknown file extension|No loader|not supported|Cannot find module/i)
    await expectFailure(run('extensionless-native-rejection', ['exec', 'matrix', 'prepare'], root), /Unknown file extension|No loader|not supported|Cannot find module/i, 'Nuxt native rejection of nuxt.config')
    assert.equal(existsSync(path.join(root, '.matrix/types/matrix-runtime.d.ts')), false)
    return
  }
  await run('extensionless-prepare', ['exec', 'matrix', 'prepare'], root)
  const output = path.join(root, '.matrix/types/matrix-runtime.d.ts')
  const declaration = readFileSync(output, 'utf8')
  assert.match(declaration, /readonly selected: string/)
  await run('extensionless-build', ['exec', 'matrix', 'build', 'app'], root)
  assert.equal(readFileSync(output, 'utf8'), declaration)
}

export async function verifyNuxtLayerSelection(cwd, version, run) {
  await verifyNuxtExtensionlessSelection(cwd, run)
  const archive = new TarArchive({ gzip: true })
  const chunks = []
  const completed = new Promise((resolve, reject) => {
    archive.on('data', chunk => chunks.push(chunk))
    archive.once('end', resolve)
    archive.once('error', reject)
  })
  archive.append(`export default defineNuxtConfig({
    vite: { plugins: [{ name: 'remote-layer-field', configResolved(config) { config.env.LAYER_REMOTE = 'remote-layer-value' } }] },
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
          targets: { build: 'node build.mjs' },
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
      write(root, 'app/app.vue', `<script setup>
        import { matrix } from 'virtual:matrix/runtime'
      </script><template><main>{{ matrix.config.marker }}:{{ matrix.config.enabled }}:{{ matrix.config.count }}:
        {{ matrix.config.nested }}:{{ matrix.config.package }}:{{ matrix.config.remote }}</main></template>`)
      write(root, 'build.mjs', `
        import { loadNuxt, buildNuxt } from 'nuxt/kit'
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
          await buildNuxt(nuxt)
        } finally {
          await nuxt?.close()
          if (link) unlinkSync('nuxt.config.mjs')
          if (selected) renameSync('unselected-config.saved', 'nuxt.config.ts')
        }
      `)
      // The build control uses native discovery, not Matrix's root-file adapter.
      await run(`layers-${scenario}-prepare`, ['exec', 'matrix', 'prepare'], root)
      const output = path.join(root, '.matrix/types/matrix-runtime.d.ts')
      const declaration = readFileSync(output, 'utf8')
      for (const field of ['enabled: boolean', 'count: number', 'marker: string', 'nested: string', 'package: string', 'remote: string', 'second: string'])
        assert.ok(declaration.includes(`readonly ${field}`), `${scenario} omitted Layer field ${field}`)
      assert.equal(declaration.includes('readonly first: string'), version === '4.6.3', 'Root env merging must use the selected Nuxt version')
      assert.doesNotMatch(declaration, /LAYER_PRIVATE_SENTINEL|privateToken/)
      await run(`layers-${scenario}-build`, ['exec', 'matrix', 'build', 'app'], root)
      assert.equal(readFileSync(output, 'utf8'), declaration, `${scenario} changed the prepared contract`)
      const outputCode = code(path.join(root, '.output/public'))
      for (const value of ['selected-layer-value', 'nested-layer-value', 'package-layer-value', 'remote-layer-value', 'selected-root-title'])
        assert.ok(outputCode.includes(value), `${scenario} build omitted ${value}`)
      assert.doesNotMatch(outputCode, /LAYER_PRIVATE_SENTINEL/)
      write(root, `local/nuxt.config.${layerExtension}`, 'throw new Error("Layer config failure")')
      await expectFailure(run(`layers-${scenario}-failure`, ['exec', 'matrix', 'prepare'], root), /Layer config failure/, `${scenario} Layer configuration failure`)
      assert.equal(readFileSync(output, 'utf8'), declaration, 'Failed Layer load replaced declarations')
      if (scenario === 'ts-mjs') {
        write(root, `local/nuxt.config.${layerExtension}`, localLayer)
        write(root, sourceFile, selected.replace(remote, remote.replace('layer.tar.gz', 'missing.tar.gz')))
        await expectFailure(run('layers-remote-failure', ['exec', 'matrix', 'prepare'], root), /404|Failed to download|fetch|not found/i, 'Remote Layer fetch failure')
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

/** Native Nuxt commands consume standard env; Matrix never loads a Nuxt builder. */
export async function verifyNuxtCompatibility(tarball, root, compatibility, timings) {
  mkdirSync(root, { recursive: true })
  for (const version of compatibility.nuxt.versions) {
    const cwd = path.join(root, `nuxt-${version}`)
    mkdirSync(cwd)
    write(cwd, 'package.json', {
      private: true,
      type: 'module',
      dependencies: {
        '@xova/matrix': `file:${tarball}`,
        'nuxt': version,
        ...compatibility.typecheck.dependencies,
        ...compatibility.vite8Dependencies,
        ...compatibility.nuxt.dependencies,
        'matrix-test-layer': 'file:./fixture-layer',
      },
    })
    write(cwd, 'fixture-layer/package.json', { name: 'matrix-test-layer', version: '1.0.0', type: 'module', main: './nuxt.config.mts' })
    write(cwd, 'fixture-layer/nuxt.config.mts', `export default defineNuxtConfig({
      vite: { plugins: [{ name: 'package-layer-field', configResolved(config) { config.env.LAYER_PACKAGE = 'package-layer-value' } }] },
    })`)
    write(cwd, 'pnpm-workspace.yaml', [
      'autoInstallPeers: false',
      'resolvePeersFromWorkspaceRoot: false',
      'allowBuilds:',
      '  esbuild: true',
      `overrides: ${JSON.stringify(compatibility.nuxt.overrides?.[version] ?? {})}`,
    ].join('\n'))
    write(cwd, 'matrix.config.mjs', `export default ${JSON.stringify({
      projects: Object.fromEntries(['spa', 'server'].map(name => [name, {
        root: name,
        typegen: false,
        prepare: 'node ../prepared.mjs',
        targets: { build: 'node ../build.mjs', dev: 'nuxt dev' },
      }])),
      products: Object.fromEntries(['alpha', 'beta'].map(name => [name, {
        env: { NUXT_PUBLIC_API_BASE: `${name}-public`, PRIVATE_BUILD_TOKEN: 'PRIVATE_BUILD_SENTINEL' },
        variants: { spa: 'spa', server: 'server' },
      }])),
    })}`)
    write(cwd, 'prepared.mjs', 'import { appendFileSync } from "node:fs"; appendFileSync("prepared", "once;")')
    write(cwd, 'build.mjs', `
      import assert from 'node:assert/strict'
      import { existsSync, readFileSync } from 'node:fs'
      import { spawnSync } from 'node:child_process'
      import { fileURLToPath } from 'node:url'
      assert.equal(process.env.__MATRIX_TYPE_CONTRACT, undefined)
      const loads = existsSync('../host-loads') ? readFileSync('../host-loads', 'utf8') : ''
      assert.equal(loads, process.env.NATIVE_EXPECTED_LOADS, 'Matrix automatic prepare evaluated Nuxt config')
      const cli = fileURLToPath(new URL('./bin/nuxt.mjs', import.meta.resolve('nuxt/package.json')))
      const result = spawnSync(process.execPath, [cli, process.env.MATRIX_PROJECT === 'spa' ? 'generate' : 'build'], { stdio: 'inherit' })
      if (result.error) throw result.error
      process.exitCode = result.status ?? 1
    `)
    write(cwd, 'base/nuxt.config.ts', `export default defineNuxtConfig({
      runtimeConfig: { privateToken: '', public: { apiBase: '' } },
      app: { head: { title: 'Matrix Native Nuxt' } },
    })`)
    for (const name of ['spa', 'server']) {
      write(cwd, `${name}/nuxt.config.ts`, `
        import { appendFileSync } from 'node:fs'
        appendFileSync('../host-loads', '${name};')
        export default defineNuxtConfig({
          extends: ['../base'],
          ssr: ${name === 'server'},
          devtools: { enabled: false },
          nitro: { preset: 'node-server' },
        })
      `)
      write(cwd, `${name}/app/app.vue`, '<template><NuxtPage /></template>')
      write(cwd, `${name}/app/pages/index.vue`, `<script setup lang="ts">
        const config = useRuntimeConfig()
        const apiBase: string = config.public.apiBase
        const count = ref(0)
      </script>
      <template><main><h1>Native Nuxt</h1><p id="api-base">{{ apiBase }}</p><button id="increment" @click="count++">Count {{ count }}</button><NuxtLink id="next" to="/next">Next page</NuxtLink></main></template>`)
      write(cwd, `${name}/app/pages/next.vue`, `<script setup lang="ts">const config = useRuntimeConfig()</script>
        <template><main><h1>Next page</h1><p id="api-base">{{ config.public.apiBase }}</p><NuxtLink to="/">Home</NuxtLink></main></template>`)
      write(cwd, `${name}/server/api/config.get.ts`, `export default defineEventHandler((event) => {
        const config = useRuntimeConfig(event)
        const privateToken: string = config.privateToken
        return { apiBase: config.public.apiBase, privatePresent: Boolean(privateToken), privateMatched: privateToken === process.env.NUXT_PRIVATE_TOKEN }
      })`)
      write(cwd, `${name}/tsconfig.json`, { extends: './.nuxt/tsconfig.json' })
    }
    const run = (phase, args, directory = cwd, env) => timings.measure(`nuxt-${version}`, phase, () => execa('pnpm', args, { cwd: directory, env, timeout: 180_000 }))
    await run('install', ['install', '--strict-peer-dependencies'])
    await run('matrix-prepare', ['exec', 'matrix', 'prepare'])
    assert.equal(existsSync(path.join(cwd, 'host-loads')), false, 'Explicit prepare loaded Nuxt configuration')
    for (const name of ['spa', 'server']) {
      const project = path.join(cwd, name)
      assert.equal(readFileSync(path.join(project, 'prepared'), 'utf8'), 'once;')
      assert.equal(existsSync(path.join(project, '.matrix')), false)
      await run(`${name}-types`, ['exec', 'nuxt', 'typecheck'], project)
      const types = code(path.join(project, '.nuxt'))
      assert.doesNotMatch(types, /virtual:matrix\/runtime|\.matrix\/types/)
    }
    for (const name of ['alpha', 'beta']) {
      const loads = readFileSync(path.join(cwd, 'host-loads'), 'utf8')
      await run(`spa-${name}`, ['exec', 'matrix', 'build', name, '--variant', 'spa'], cwd, { NATIVE_EXPECTED_LOADS: loads })
      const publicRoot = path.join(cwd, 'spa/.output/public')
      const output = code(publicRoot)
      assert.match(output, new RegExp(`${name}-public`))
      assert.doesNotMatch(output, new RegExp(`${name === 'alpha' ? 'beta' : 'alpha'}-public|PRIVATE_BUILD_SENTINEL|virtual:matrix/runtime`))
      assert.equal(existsSync(path.join(cwd, 'spa/.matrix')), false)
    }
    const loads = readFileSync(path.join(cwd, 'host-loads'), 'utf8')
    await run('server-build', ['exec', 'matrix', 'build', 'alpha', '--variant', 'server'], cwd, { NATIVE_EXPECTED_LOADS: loads })
    assert.doesNotMatch(code(path.join(cwd, 'server/.output')), /PRIVATE_BUILD_SENTINEL|private-deployment/)
    assert.equal(existsSync(path.join(cwd, 'server/.matrix')), false)
    await timings.measure(`nuxt-${version}`, 'node-runtime', () => verifyNodeOutput(cwd, path.join(cwd, 'server')))
    console.log(`Package native Nuxt command integration passed: nuxt-${version}`)
    await verifyMixedNuxt(cwd, version, run)
    await verifyNuxtLayerSelection(cwd, version, run)
  }
}
