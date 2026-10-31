import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { execa } from 'execa'
import path from 'pathe'
import { expectFailure, fixtureCode, writeFixture as write } from './pack-fixtures.mjs'
import { runConsumers } from './pack-matrix.mjs'

function fixture(root, tarball, version, electron, compatibility) {
  mkdirSync(root, { recursive: true })
  write(root, 'package.json', {
    name: electron ? `electron-${version}` : `vite-${version}`,
    private: true,
    type: 'module',
    dependencies: {
      '@xova/matrix': `file:${tarball}`,
      ...compatibility.typecheck.dependencies,
      'vite': version,
      // Rolldown's optional WASM binding also requires explicit peers in strict installs.
      ...(version.startsWith('8.') ? compatibility.vite8Dependencies : {}),
      ...(electron ? { ...compatibility.electron.dependencies, 'electron-vite': electron } : {}),
    },
  })
  write(root, 'matrix.config.mjs', `export default ${JSON.stringify({
    envSchema: {
      VITE_ENABLED: { type: 'boolean', default: false },
      VITE_LIMIT: { type: 'number', default: 3 },
    },
    projects: { web: { targets: { build: 'node verify-build.mjs' } } },
    products: { app: { env: {
      VITE_LABEL: `public-${version}`,
      PRIVATE_TOKEN: 'PRIVATE_SENTINEL',
      MAIN_VITE_MAIN_ONLY: 'MAIN_SENTINEL',
      PRELOAD_VITE_PRELOAD_ONLY: 'PRELOAD_SENTINEL',
    }, variants: { web: 'web' } } },
  })}`)
  write(root, 'vite.config.ts', [
    'import { defineConfig } from \'vite\'',
    'import matrix from \'@xova/matrix/vite\'',
    'export default defineConfig({ plugins: [matrix()] })',
  ].join('\n'))
  write(root, 'tsconfig.json', {
    compilerOptions: compatibility.typecheck.compilerOptions,
    include: ['*.ts', '.matrix/types/**/*.d.ts'],
  })
  write(root, 'check.ts', [
    'import { matrix } from \'virtual:matrix/runtime\'',
    'const enabled: boolean = matrix.config.enabled',
    'const limit: number = matrix.config.limit',
    'const label: string = matrix.config.label',
    '// @ts-expect-error Private fields must not enter the public type contract.',
    'matrix.config.privateToken',
    '// @ts-expect-error Runtime fields are read-only.',
    'matrix.config.label = label',
  ].join('\n'))
  write(root, 'entry.ts', [
    'import { matrix } from \'virtual:matrix/runtime\'',
    'if (matrix.isDevelopment) void import(\'./dev-only.js\')',
    'export const value = [matrix.config.label, matrix.config.enabled, matrix.config.limit,',
    '  Object.isFrozen(matrix), Object.isFrozen(matrix.product), Object.isFrozen(matrix.config)]',
  ].join('\n'))
  write(root, 'dev-only.ts', 'export const sentinel = "DEV_ONLY_SENTINEL"; console.log(sentinel)')
  write(root, 'verify-build.mjs', [
    'import assert from \'node:assert/strict\'',
    'import { createRequire } from \'node:module\'',
    'import { build, createServer, version } from \'vite\'',
    'import matrix from \'@xova/matrix/vite\'',
    'const require = createRequire(import.meta.url)',
    `assert.equal(version, ${JSON.stringify(version)})`,
    // Inspect from the real installed Matrix entry, not a workspace symlink.
    'assert.equal(createRequire(import.meta.resolve(\'@xova/matrix/vite\')).resolve(\'vite\'), require.resolve(\'vite\'))',
    'for (const inline of [true, false]) {',
    '  const result = await build({ configFile: false, plugins: [matrix({ inline })], logLevel: "silent",',
    '    build: { write: false, minify: false, lib: { entry: "entry.ts", formats: ["es"] } } })',
    '  const output = result[0].output',
    '  const entry = output.find(item => item.type === "chunk" && item.isEntry)',
    '  const built = await import("data:text/javascript;base64," + Buffer.from(entry.code).toString("base64"))',
    `  assert.deepEqual(built.value, [${JSON.stringify(`public-${version}`)}, false, 3, true, true, true])`,
    '  const code = output.filter(item => item.type === "chunk").map(item => item.code).join(String.fromCharCode(10))',
    '  assert.doesNotMatch(code, /PRIVATE_SENTINEL|MAIN_SENTINEL|PRELOAD_SENTINEL/)',
    '  if (inline) {',
    '    assert.equal(output.filter(item => item.type === "chunk").length, 1)',
    '    assert.doesNotMatch(code, /DEV_ONLY_SENTINEL/)',
    '  }',
    '}',
    'const server = await createServer({ configFile: false, plugins: [matrix()], logLevel: "silent",',
    '  server: { middlewareMode: true, watch: null, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } })',
    'try {',
    '  const transformed = await server.transformRequest("/entry.ts")',
    `  assert.ok(transformed?.code.includes(${JSON.stringify(`public-${version}`)}))`,
    '  assert.doesNotMatch(transformed.code, /PRIVATE_SENTINEL|MAIN_SENTINEL|PRELOAD_SENTINEL/)',
    '} finally { await server.close() }',
  ].join('\n'))
  if (electron) {
    write(root, 'electron-entry.ts', 'export {}')
    write(root, 'index.html', '<div>Matrix renderer</div>')
    write(root, 'electron.vite.config.ts', [
      'import { defineConfig } from \'electron-vite\'',
      'import matrix from \'@xova/matrix/vite\'',
      'export default defineConfig({',
      '  main: { plugins: [matrix({ scope: "main" })], build: { lib: { entry: "electron-entry.ts" } } },',
      '  preload: { plugins: [matrix({ scope: "preload" })], build: { lib: { entry: "electron-entry.ts" } } },',
      '  renderer: { root: ".", plugins: [matrix()], build: { rollupOptions: { input: "index.html" } } },',
      '})',
    ].join('\n'))
    write(root, 'check-electron.ts', [
      'import { matrix as main } from \'virtual:matrix/runtime/main\'',
      'import { matrix as preload } from \'virtual:matrix/runtime/preload\'',
      'const mainOnly: string = main.config.mainOnly',
      'const preloadOnly: string = preload.config.preloadOnly',
      '// @ts-expect-error Preload-only fields must not leak into main.',
      'main.config.preloadOnly',
      '// @ts-expect-error Main-only fields must not leak into preload.',
      'preload.config.mainOnly',
    ].join('\n'))
  }
}

async function verifyNativeVite(root, consumer, compatibility, timings) {
  const cwd = path.join(root, 'native')
  mkdirSync(cwd)
  write(cwd, 'package.json', { private: true, type: 'module' })
  write(cwd, 'matrix.config.mjs', `export default ${JSON.stringify({
    projects: { web: { typegen: false, targets: { build: 'node build.mjs' } } },
    products: Object.fromEntries(['alpha', 'beta'].map(name => [name, {
      env: { VITE_API_BASE: `${name}-native`, PRIVATE_TOKEN: 'PRIVATE_NATIVE_SENTINEL' },
      variants: { web: 'web' },
    }])),
  })}`)
  write(cwd, 'vite.config.mjs', `
    import { appendFileSync } from 'node:fs'
    appendFileSync('host-loads', 'loaded;')
    export default { build: { lib: { entry: 'entry.ts', formats: ['es'], fileName: () => 'native.mjs' } } }
  `)
  write(cwd, 'entry.ts', `
    export const value: string = import.meta.env.VITE_API_BASE
    export const privateValue = import.meta.env.PRIVATE_TOKEN
    export const matrixValue = import.meta.env.MATRIX_PRODUCT_KEY
  `)
  write(cwd, 'tsconfig.json', { compilerOptions: { ...compatibility.typecheck.compilerOptions, types: ['vite/client'] }, include: ['entry.ts'] })
  write(cwd, 'build.mjs', `
    import assert from 'node:assert/strict'
    import { existsSync, readFileSync } from 'node:fs'
    import { build } from 'vite'
    assert.equal(process.env.__MATRIX_TYPE_CONTRACT, undefined)
    const before = existsSync('host-loads') ? readFileSync('host-loads', 'utf8') : ''
    assert.equal(before, process.env.NATIVE_EXPECTED_LOADS, 'Matrix automatic prepare evaluated the native host')
    await build({ logLevel: 'silent' })
    const output = await import('./dist/native.mjs')
    assert.equal(output.value, process.env.MATRIX_PRODUCT_KEY + '-native')
    assert.equal(output.privateValue, undefined)
    assert.equal(output.matrixValue, undefined)
    const code = readFileSync('dist/native.mjs', 'utf8')
    assert.doesNotMatch(code, /PRIVATE_NATIVE_SENTINEL|virtual:matrix|@xova\\/matrix/)
    assert.equal(existsSync('.matrix'), false)
  `)
  const run = (phase, args, env) => {
    const entry = args[0] === 'matrix' ? '@xova/matrix/bin/matrix.mjs' : 'typescript/bin/tsc'
    return timings.measure(consumer.name, phase, () => execa(process.execPath, [path.join(root, 'node_modules', entry), ...args.slice(1)], { cwd, env, timeout: 60_000 }))
  }
  await run('native-prepare', ['matrix', 'prepare'])
  assert.equal(existsSync(path.join(cwd, 'host-loads')), false, 'Explicit prepare loaded a native host')
  assert.equal(existsSync(path.join(cwd, '.matrix')), false)
  await run('native-types', ['tsc', '--noEmit'])
  for (const name of ['alpha', 'beta']) {
    const loads = existsSync(path.join(cwd, 'host-loads')) ? readFileSync(path.join(cwd, 'host-loads'), 'utf8') : ''
    await run(`native-build-${name}`, ['matrix', 'build', name], { NATIVE_EXPECTED_LOADS: loads })
  }
}

export async function verifyConfigSelection(root, consumer, timings) {
  const host = consumer.electron ? 'electron-vite' : 'vite'
  const basename = consumer.electron ? 'electron.vite.config' : 'vite.config'
  const cwd = path.join(root, 'config-selection')
  mkdirSync(cwd)
  write(cwd, 'package.json', { private: true, type: 'module' })
  const run = (phase, args) => timings.measure(consumer.name, phase, () => execa(process.execPath, [path.join(root, 'node_modules/@xova/matrix/bin/matrix.mjs'), ...args.slice(1)], { cwd, timeout: 60_000 }))
  write(cwd, 'index.html', '<script type="module" src="/entry.ts"></script>')
  write(cwd, 'entry.ts', `import { matrix } from 'virtual:matrix/runtime'; console.log(matrix.config.selected)`)
  write(cwd, 'electron-entry.ts', `import { matrix } from 'virtual:matrix/runtime/main'; console.log(matrix.config.selected)`)
  write(cwd, 'build.mjs', `
    import { build } from '${host}'
    await build({ configFile: process.env.SELECTED_CONFIG, logLevel: 'silent' })
  `)
  write(cwd, 'control.mjs', `
    import { resolveConfig } from '${host}'
    await resolveConfig({ configFile: process.argv[2], logLevel: 'silent' }, 'build', 'production')
  `)
  for (const filename of [...['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map(extension => `${basename}.${extension}`), 'custom.config.mjs', basename]) {
    const explicit = filename === 'custom.config.mjs' || filename === basename
    const value = `selected-${filename}-value`
    const config = consumer.electron
      ? `{ main: { plugins: [matrix({ scope: 'main', envPrefix: 'APP_' })], build: { lib: { entry: 'electron-entry.ts' } } },
           renderer: { root: '.', plugins: [matrix({ envPrefix: 'APP_' })], build: { rollupOptions: { input: 'index.html' } } } }`
      : `{ plugins: [matrix({ envPrefix: 'APP_' })] }`
    const cjs = /\.(?:cjs|cts)$/.test(filename)
    write(cwd, filename, cjs
      ? `module.exports = async () => { const matrix = (await import('@xova/matrix/vite')).default; return ${config} }`
      : `import matrix from '@xova/matrix/vite'; export default ${config}`)
    write(cwd, 'matrix.config.mjs', `export default ${JSON.stringify({
      envSchema: { APP_ENABLED: { type: 'boolean', default: true } },
      projects: { web: { ...(explicit && { configFile: filename }), ...(filename === 'custom.config.mjs' && { configHost: host }), targets: { build: 'node build.mjs' } } },
      products: { app: { env: { APP_SELECTED: value, SELECTED_CONFIG: filename }, variants: { web: 'web' } } },
    })}`)
    if (explicit)
      write(cwd, `${basename}.ts`, 'throw new Error("Explicit config must bypass the default candidate")')
    if (filename === basename) {
      mkdirSync(path.join(cwd, 'control'))
      writeFileSync(path.join(cwd, 'control', filename), 'export default {}')
      const native = await execa(process.execPath, ['control.mjs', `control/${filename}`], { cwd, reject: false })
      if (native.exitCode !== 0) {
        await expectFailure(run(`config-${filename}-native-rejection`, ['matrix', 'prepare']), /No loader|Unknown file extension|not supported|failed to load config/i, `${host} native rejection of ${filename}`)
        unlinkSync(path.join(cwd, filename))
        unlinkSync(path.join(cwd, `${basename}.ts`))
        continue
      }
    }
    await run(`config-${filename}-prepare`, ['matrix', 'prepare'])
    const declaration = readFileSync(path.join(cwd, '.matrix/types/matrix-runtime.d.ts'), 'utf8')
    assert.match(declaration, /readonly enabled: boolean/)
    assert.match(declaration, /readonly selected: string/)
    await run(`config-${filename}-build`, ['matrix', 'build', 'app'])
    assert.equal(readFileSync(path.join(cwd, '.matrix/types/matrix-runtime.d.ts'), 'utf8'), declaration)
    const output = consumer.electron ? 'out/renderer' : 'dist'
    assert.ok(existsSync(path.join(cwd, output)), `${host} did not build ${filename}`)
    const outputCode = fixtureCode(path.join(cwd, output), /\.m?js$/)
    assert.ok(outputCode.includes(value), `${host} did not build the selected ${filename}`)
    // Leave no neighboring candidate for the next automatic-discovery case.
    unlinkSync(path.join(cwd, filename))
    if (explicit)
      unlinkSync(path.join(cwd, `${basename}.ts`))
  }
}

/** Install the tarball into a real mixed-version pnpm workspace, without root Vite. */
export async function verifyViteCompatibility(tarball, root, compatibility, concurrency, timings) {
  mkdirSync(root)
  write(root, 'package.json', { private: true })
  write(root, 'pnpm-workspace.yaml', [
    'packages:',
    '  - "vite-*"',
    '  - "electron-*"',
    'autoInstallPeers: false',
    'resolvePeersFromWorkspaceRoot: false',
    'allowBuilds:',
    '  "@swc/core": false',
    '  electron: false',
    '  esbuild: true',
  ].join('\n'))
  const consumers = [
    ...compatibility.hosts.vite.map(version => ({ name: `vite-${version}`, version })),
    ...compatibility.electron.combinations.map(host => ({ name: `electron-${host.vite}`, version: host.vite, electron: host.electronVite })),
  ]
  for (const consumer of consumers)
    fixture(path.join(root, consumer.name), tarball, consumer.version, consumer.electron, compatibility)
  await timings.measure('vite-workspace', 'install', () => execa('pnpm', ['install', '--strict-peer-dependencies'], { cwd: root, timeout: 180_000 }))

  const failures = []
  await runConsumers(consumers, concurrency, async (consumer) => {
    const cwd = path.join(root, consumer.name)
    const run = (phase, args) => timings.measure(consumer.name, phase, () => execa('pnpm', ['exec', ...args], { cwd, timeout: 60_000 }))
    try {
      await run('prepare', ['matrix', 'prepare', 'app'])
      const declaration = readFileSync(path.join(cwd, '.matrix/types/matrix-runtime.d.ts'), 'utf8')
      assert.match(declaration, /readonly enabled: boolean/)
      assert.match(declaration, /readonly limit: number/)
      assert.doesNotMatch(declaration, /public-|SENTINEL/)
      if (consumer.electron) {
        for (const scope of ['main', 'preload']) {
          const scoped = readFileSync(path.join(cwd, `.matrix/types/matrix-runtime-${scope}.d.ts`), 'utf8')
          assert.ok(scoped.includes(`virtual:matrix/runtime/${scope}`))
          assert.match(scoped, new RegExp(`readonly ${scope}Only: string`))
          assert.doesNotMatch(scoped, scope === 'main' ? /PRELOAD_VITE_|SENTINEL/ : /MAIN_VITE_|SENTINEL/)
        }
      }
      await run('types', ['tsc', '--noEmit'])
      if (!consumer.electron) {
        await run('build', ['matrix', 'build', 'app'])
        await verifyNativeVite(cwd, consumer, compatibility, timings)
      }
      if (consumer.version === compatibility.hosts.vite[0] || consumer.version === compatibility.hosts.vite.at(-1) || consumer.electron)
        await verifyConfigSelection(cwd, consumer, timings)
      console.log(`Package Vite compatibility passed: ${consumer.name}`)
    }
    catch (error) {
      console.error(`Package Vite compatibility failed: ${consumer.name}\n${error.message}`)
      failures.push(new Error(`${consumer.name} failed`, { cause: error }))
    }
  })
  if (failures.length)
    throw new AggregateError(failures, `Packaged Vite compatibility failed on Node ${process.version}`)
}
