#!/usr/bin/env node

import process from 'node:process'
import consola from 'consola'
import { runCli } from '../dist/cli.js'

runCli().catch((error) => {
  consola.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
