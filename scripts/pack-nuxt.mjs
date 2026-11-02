import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { delimiter } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { execa } from 'execa'
import path from 'pathe'
import { fixtureCode as code, fixtureFiles, writeFixture as write } from './pack-fixtures.mjs'
import { verifyNuxtLayerSelection } from './pack-nuxt-layers.mjs'

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
        assert.match(html, /local-layer-value:package-layer-value:remote-layer-value/)
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

/** Native projects remain host-free to Matrix, but Nuxt still prepares their own types. */
async function verifyNativeNuxt(cwd, run) {
  const workspace = path.join(cwd, 'native')
  write(workspace, 'matrix.config.mjs', `export default ${JSON.stringify({
    projects: { app: { root: 'app', typegen: false, prepare: 'node ../prepared.mjs', targets: { build: 'nuxt prepare' } } },
    products: { alpha: { env: { NUXT_PUBLIC_API_BASE: 'alpha-native' }, variants: { web: 'app' } } },
  })}`)
  write(workspace, 'prepared.mjs', 'import assert from "node:assert/strict"; import { appendFileSync } from "node:fs"; assert.equal(process.env.__MATRIX_TYPE_CONTRACT, undefined); appendFileSync("prepared", "once;")')
  write(workspace, 'app/nuxt.config.ts', `import assert from 'node:assert/strict'
    import { appendFileSync } from 'node:fs'
    assert.equal(process.env.__MATRIX_TYPE_CONTRACT, undefined)
    assert.equal(process.env.NUXT_PUBLIC_API_BASE, 'alpha-native')
    appendFileSync('../host-loads', 'nuxt;')
    export default defineNuxtConfig({ ssr: false, devtools: { enabled: false } })`)
  await run('native-matrix-prepare', ['exec', 'matrix', 'prepare'], workspace)
  assert.equal(existsSync(path.join(workspace, 'host-loads')), false, 'Explicit prepare loaded native Nuxt configuration')
  assert.equal(readFileSync(path.join(workspace, 'app/prepared'), 'utf8'), 'once;')
  await run('native-nuxt-prepare', ['exec', 'matrix', 'build', 'alpha'], workspace)
  assert.equal(readFileSync(path.join(workspace, 'app/prepared'), 'utf8'), 'once;once;')
  assert.ok(readFileSync(path.join(workspace, 'host-loads'), 'utf8').includes('nuxt;'))
  assert.doesNotMatch(code(path.join(workspace, 'app/.nuxt')), /virtual:matrix\/runtime|\.matrix\/types/)
  assert.equal(existsSync(path.join(workspace, '.matrix')), false)
  assert.equal(existsSync(path.join(workspace, 'app/.matrix')), false)
}

async function verifyMixedNuxt(cwd, version, run, remote) {
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
    vite: { plugins: [{ name: 'local-layer-field', configResolved(config) { config.env.NUXT_PUBLIC_LAYER_LOCAL = 'local-layer-value' } }] },
  })`)
  write(root, 'nuxt.config.ts', `import { dirname } from 'node:path'
  import { fileURLToPath } from 'node:url'
  export default defineNuxtConfig({
    rootDir: dirname(fileURLToPath(import.meta.url)),
    ssr: true,
    srcDir: 'src',
    extends: ['../../../mixed-layer', 'matrix-test-layer', ${JSON.stringify(remote)}],
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
  <p id="layers">{{ matrix.config.layerLocal }}:{{ matrix.config.layerPackage }}:{{ matrix.config.layerRemote }}</p>
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
  for (const field of ['alphaOnly?: string', 'betaOnly?: string', 'enabled: boolean', 'lateField: string', 'compatLabel: string', 'typedCount: number', 'VITE_TYPED_COUNT: string', 'layerLocal: string', 'layerPackage: string', 'layerRemote: string'])
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
  const configFile = path.join(root, 'nuxt.config.ts')
  const config = readFileSync(configFile, 'utf8')
  const runtimeOnlyConfig = config.replace(JSON.stringify(moduleOptions), runtimeOnlyOptions)
  const layerFile = path.join(cwd, 'mixed-layer/nuxt.config.ts')
  const layer = readFileSync(layerFile, 'utf8')
  for (const product of ['alpha', 'beta']) {
    if (product === 'beta') {
      matrixConfig.projects.web.typegen = false
      write(workspace, 'matrix.config.mjs', `export default ${JSON.stringify(matrixConfig)}`)
      write(root, 'nuxt.config.ts', runtimeOnlyConfig)
      write(cwd, 'mixed-layer/nuxt.config.ts', layer.replace(JSON.stringify(moduleOptions), runtimeOnlyOptions))
    }
    await run(`mixed-${product}`, ['exec', 'matrix', 'build', product, '--variant', 'web'], workspace)
    assert.equal(readFileSync(output, 'utf8'), declaration, 'Active product overwrote the complete type contract')
    const bundle = code(path.join(root, '.output'))
    assert.match(bundle, new RegExp(`${product}-snapshot`))
    assert.match(bundle, new RegExp(`${product}-native`))
    assert.match(bundle, new RegExp(`${product}-vite`))
    assert.match(bundle, /late-field/)
    for (const value of ['local-layer-value', 'package-layer-value', 'remote-layer-value'])
      assert.ok(bundle.includes(value), `Mixed build omitted ${value}`)
    assert.doesNotMatch(bundle, new RegExp(`${product === 'alpha' ? 'beta' : 'alpha'}-snapshot|MIXED_PRIVATE_SENTINEL|MIXED_APP_SENTINEL|__MATRIX_TYPE_CONTRACT|__MATRIX_ENV_SCHEMA`))
    await verifyNodeOutput(workspace, root, product)
  }
  // Nuxt's default NUXT_ Vite prefix must not expose private business fields.
  assert.doesNotMatch(declaration, /privateToken|appPrivate/)
  const fails = async (phase, args, rejection) => {
    const result = await run(phase, args, args[1] === 'matrix' ? workspace : root, { rejection })
    return `${result.stdout}\n${result.stderr}`
  }
  const restoreHostConfigs = () => {
    write(root, 'nuxt.config.ts', config)
    write(cwd, 'mixed-layer/nuxt.config.ts', layer)
  }
  delete matrixConfig.projects.web.typegen
  write(workspace, 'matrix.config.mjs', `export default ${JSON.stringify(matrixConfig)}`)
  restoreHostConfigs()
  try {
    for (const [name, mutate, expectedKeys] of [
      ['different-values', () => { matrixConfig.products.alpha.env.VITE_MATRIX_API = 'COLLISION_PRIVATE_VALUE' }, ['NUXT_PUBLIC_MATRIX_API', 'VITE_MATRIX_API']],
      ['cross-product', () => {
        delete matrixConfig.products.beta.env.NUXT_PUBLIC_MATRIX_API
        matrixConfig.products.beta.env.VITE_MATRIX_API = 'COLLISION_PRIVATE_VALUE'
      }, ['NUXT_PUBLIC_MATRIX_API', 'VITE_MATRIX_API']],
      ['schema', () => { matrixConfig.envSchema.NUXT_PUBLIC_TYPED_COUNT = { type: 'number', optional: true } }, ['NUXT_PUBLIC_TYPED_COUNT', 'VITE_TYPED_COUNT']],
    ]) {
      // Both hosts exercise strict collection; the shared merge/schema rules run in Vitest.
      if ((name === 'cross-product' && version !== '4.0.3') || (name === 'schema' && version !== '4.6.3'))
        continue
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
  console.log(`Package mixed Nuxt SSR, Layers and Node Nitro integration passed: nuxt-${version}`)
}

/** Each endpoint shares one installation and one mixed SSR/Layer production chain. */
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
      vite: { plugins: [{ name: 'package-layer-field', configResolved(config) { config.env.LAYER_PACKAGE = config.env.NUXT_PUBLIC_LAYER_PACKAGE = 'package-layer-value' } }] },
    })`)
    write(cwd, 'pnpm-workspace.yaml', [
      'autoInstallPeers: false',
      'resolvePeersFromWorkspaceRoot: false',
      'allowBuilds:',
      '  esbuild: true',
      `overrides: ${JSON.stringify(compatibility.nuxt.overrides?.[version] ?? {})}`,
    ].join('\n'))
    const run = (phase, args, directory = cwd, { env, ...expectation } = {}) => timings.measure(`nuxt-${version}`, phase, () => execa('pnpm', args, { cwd: directory, env, timeout: 180_000 }), expectation)
    await run('install', ['install', '--strict-peer-dependencies'])
    await verifyNativeNuxt(cwd, run)
    await verifyNuxtLayerSelection(cwd, version, run, remote => verifyMixedNuxt(cwd, version, run, remote))
  }
}
