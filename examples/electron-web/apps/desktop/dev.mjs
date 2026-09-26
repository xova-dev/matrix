/* eslint-disable antfu/no-top-level-await -- Executable example entrypoint, not a library module. */
import { createRequire } from 'node:module'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

const require = createRequire(import.meta.url)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = execa(require('electron'), [fileURLToPath(new URL('.', import.meta.url))], { env, extendEnv: false, stdio: 'inherit', reject: false, killDescendants: true })

process.on('SIGINT', () => child.kill('SIGTERM'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
const result = await child
process.exitCode = result.exitCode ?? 1
