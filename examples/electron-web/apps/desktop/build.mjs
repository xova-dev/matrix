/* eslint-disable antfu/no-top-level-await -- Executable example entrypoint, not a library module. */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { build, Platform } from 'electron-builder'
import { build as buildElectron } from 'electron-vite'

const require = createRequire(import.meta.url)
const metadata = {
  product: process.env.MATRIX_PRODUCT_KEY,
  name: process.env.MATRIX_PRODUCT_NAME,
  appId: process.env.MATRIX_PRODUCT_APP_ID,
}
if (Object.values(metadata).some(value => !value))
  throw new Error('Run this build through Matrix with a selected product')
const staging = path.resolve('dist/app')
await rm(path.resolve('dist'), { recursive: true, force: true })
await buildElectron()
await mkdir(staging, { recursive: true })
await cp(path.resolve(process.env.WEB_DIST_DIR), path.join(staging, 'web'), { recursive: true })
await cp('dist/main', path.join(staging, 'main'), { recursive: true })
await cp('dist/preload', path.join(staging, 'preload'), { recursive: true })
const base = JSON.parse(await readFile('package.json', 'utf8'))
await writeFile(path.join(staging, 'package.json'), JSON.stringify({ ...base, name: `matrix-${metadata.product}`, productName: metadata.name, main: 'main/index.js' }))
await build({
  targets: Platform.current().createTarget('dir'),
  publish: 'never',
  config: {
    appId: metadata.appId,
    productName: metadata.name,
    executableName: `matrix-${metadata.product}`,
    electronVersion: require('electron/package.json').version,
    directories: { app: staging, output: path.resolve('release') },
    files: ['**/*'],
    asar: true,
    npmRebuild: false,
    mac: { identity: null },
    win: { signAndEditExecutable: false },
  },
})
