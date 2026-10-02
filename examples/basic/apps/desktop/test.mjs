import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

async function main() {
  assert.equal(process.env.MATRIX_PROJECT, 'desktop', 'Run this check through Matrix')
  assert.equal(process.env.MATRIX_PRODUCT_KEY, 'app')
  assert.equal(process.env.MATRIX_PRODUCT_VERSION, '0.1.0')
  assert.ok(URL.canParse(process.env.VITE_API_BASE), 'Matrix must supply an API URL')
  if (process.env.MATRIX_TARGET === 'build') {
    assert.equal(await readFile('dist/desktop.txt', 'utf8'), `API: ${process.env.VITE_API_BASE}\n`)
    assert.ok((await readFile('../web/dist/index.html', 'utf8')).includes(process.env.VITE_API_BASE), 'The dependent Web build must finish first')
  }
  console.log('Desktop checks passed: Matrix context and any build outputs match')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
