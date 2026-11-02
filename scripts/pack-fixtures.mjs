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

export function assertNormalProcessExit(result) {
  // A timeout or cancellation can still let a signal handler exit with a code.
  if (!Number.isInteger(result?.exitCode)
    || result.exitCode < 0
    || result.timedOut
    || result.isCanceled
    || result.isGracefullyCanceled
    || result.isTerminated
    || result.isForcefullyTerminated
    || result.isMaxBuffer
    || result.signal !== undefined
    || result.code !== undefined
    || result.cause !== undefined) {
    throw result
  }
}

export async function expectFailure(operation, pattern, phase) {
  const result = await operation.catch(error => error)
  assertNormalProcessExit(result)
  const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.notEqual(result.exitCode, 0, `${phase} unexpectedly succeeded`)
  assert.ok(Number.isInteger(result.exitCode) && result.exitCode > 0, `${phase} did not exit with a failure code: ${result.exitCode}`)
  assert.match(diagnostic, pattern, `${phase} (exit code ${result.exitCode}): ${diagnostic}`)
  return diagnostic
}
