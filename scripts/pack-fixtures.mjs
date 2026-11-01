import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'pathe'

export function writeFixture(root, name, content) {
  const file = path.join(root, name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
}

export function fixtureFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? fixtureFiles(path.join(root, entry.name)) : [path.join(root, entry.name)])
}

export function fixtureCode(root, pattern = /\.(?:html|m?js|json)$/) {
  return fixtureFiles(root).filter(file => pattern.test(file)).map(file => readFileSync(file, 'utf8')).join('\n')
}

export async function expectFailure(operation, pattern, phase) {
  const result = await operation.catch(error => error)
  const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.notEqual(result.exitCode, 0, `${phase} unexpectedly succeeded`)
  assert.ok(Number.isInteger(result.exitCode) && result.exitCode > 0, `${phase} did not exit with a failure code: ${result.exitCode}`)
  assert.match(diagnostic, pattern, `${phase} (exit code ${result.exitCode}): ${diagnostic}`)
  return diagnostic
}
