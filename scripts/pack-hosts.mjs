import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execaSync } from 'execa'
import path from 'pathe'
import compatibility from './compatibility-matrix.json' with { type: 'json' }

function write(root, name, content) {
  writeFileSync(path.join(root, name), typeof content === 'string' ? content : JSON.stringify(content))
}

export function verifyHostCompatibility(tarball, root) {
  mkdirSync(root)
  write(root, 'package.json', { private: true })
  write(root, 'pnpm-workspace.yaml', [
    'packages:',
    '  - "*-*"',
    'autoInstallPeers: false',
    'resolvePeersFromWorkspaceRoot: false',
    'allowBuilds:',
    '  esbuild: true',
  ].join('\n'))
  const consumers = Object.entries(compatibility.hosts).filter(([host]) => host !== 'vite').flatMap(([host, versions]) => versions.map(version => ({ host, version })))
  for (const { host, version } of consumers) {
    const cwd = path.join(root, `${host}-${version}`)
    mkdirSync(cwd)
    write(cwd, 'package.json', { name: `${host}-${version}`, private: true, type: 'module', dependencies: {
      '@xova/matrix': `file:${tarball}`,
      ...compatibility.typecheck.dependencies,
      [host]: version,
    } })
    write(cwd, 'matrix.config.mjs', `export default ${JSON.stringify({
      envSchema: { APP_ENABLED: { type: 'boolean', default: false }, APP_LIMIT: { type: 'number', default: 3 } },
      projects: { app: { targets: { build: `node verify.mjs ${host}` } } },
      products: { app: { env: { APP_LABEL: 'fixture', PRIVATE_SECRET: 'PRIVATE_SENTINEL' }, variants: { app: 'app' } } },
    })}`)
    write(cwd, 'entry.js', [
      'import { matrix } from "virtual:matrix/runtime"',
      'if (matrix.isDevelopment) void import("./dev-only.js")',
      'export const value = [matrix.config.enabled, matrix.config.limit, matrix.config.label,',
      '  Object.isFrozen(matrix), Object.isFrozen(matrix.product), Object.isFrozen(matrix.config)]',
    ].join('\n'))
    write(cwd, 'dev-only.js', 'console.log("DEV_ONLY_SENTINEL")')
    write(cwd, 'check.ts', [
      `import matrix from "@xova/matrix/${host}"`,
      `import type { ${host === 'webpack' ? 'Configuration' : host === 'rollup' ? 'RollupOptions' : 'BuildOptions'} as Options } from "${host}"`,
      'const config: Options = { plugins: [matrix({ envPrefix: "APP_" })] }',
    ].join('\n'))
    write(cwd, 'tsconfig.json', { compilerOptions: compatibility.typecheck.compilerOptions, include: ['check.ts'] })
    copyFileSync(fileURLToPath(new URL('./pack-host-fixture.mjs', import.meta.url)), path.join(cwd, 'verify.mjs'))
  }
  execaSync('pnpm', ['install', '--strict-peer-dependencies'], { cwd: root, timeout: 180_000 })
  const failures = []
  for (const { host, version } of consumers) {
    const cwd = path.join(root, `${host}-${version}`)
    for (const [phase, args] of [['types', ['tsc', '--noEmit']], ['build', ['matrix', 'build', 'app']]]) {
      try {
        execaSync('pnpm', ['exec', ...args], { cwd, timeout: 60_000 })
        console.log(`Package host passed: ${host}@${version} ${phase}`)
      }
      catch (error) {
        console.error(`Package host failed: ${host}@${version} ${phase}\n${error.message}`)
        failures.push(new Error(`${host}@${version} ${phase} failed`, { cause: error }))
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, 'Packaged host compatibility failed')
}
