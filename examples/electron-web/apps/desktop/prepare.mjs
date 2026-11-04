/* eslint-disable antfu/no-top-level-await -- Executable example entrypoint, not a library module. */
import { appendFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import process from 'node:process'
import { execa } from 'execa'

const require = createRequire(import.meta.url)
await execa(process.execPath, [require.resolve('electron/install.js')], { stdio: 'inherit' })
await mkdir('.prepared', { recursive: true })
await appendFile('.prepared/runs.jsonl', JSON.stringify({ product: process.env.MATRIX_PRODUCT_KEY, target: process.env.MATRIX_TARGET, environment: process.env.MATRIX_ENV_NAME }) + String.fromCharCode(10))
