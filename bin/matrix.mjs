#!/usr/bin/env node

import process from 'node:process'
import consola from 'consola'
import { runCli } from '../dist/cli.js'

function restoreTerminal() {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    try {
      process.stdin.setRawMode(false)
    }
    catch {
      // The TTY may already be unavailable while the process is exiting.
    }
  }

  process.stdin.pause()

  if (process.stdout.isTTY)
    process.stdout.write('\u001B[?25h')
}

async function main() {
  try {
    await runCli()
  }
  catch (error) {
    consola.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
  finally {
    restoreTerminal()
  }
}

main()
