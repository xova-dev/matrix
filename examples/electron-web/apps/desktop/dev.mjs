/* eslint-disable antfu/no-top-level-await -- Executable example entrypoint, not a library module. */
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const cli = fileURLToPath(new URL('../bin/electron-vite.js', import.meta.resolve('electron-vite')))
// Keep the framework CLI and its Electron descendants in a supervised process tree.
const args = [cli, 'dev', '--watch', ...(env.EXAMPLE_SMOKE_OUTPUT ? ['--noSandbox'] : [])]
const child = execa(process.execPath, args, { env, extendEnv: false, stdio: 'inherit', reject: false, killDescendants: true })
process.on('SIGINT', () => child.kill('SIGTERM'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
const result = await child
process.exitCode = result.exitCode ?? 1
