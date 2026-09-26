// Keep test programs out of shell quoting; only this file path crosses the shell.
const { Buffer } = require('node:buffer')
const process = require('node:process')

// eslint-disable-next-line no-eval -- Only executes controlled test fixture programs.
eval(Buffer.from(process.env.MATRIX_TEST_SCRIPT, 'base64').toString())
