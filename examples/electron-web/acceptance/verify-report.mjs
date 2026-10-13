import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

function assertReport(report, product, environment, packaged) {
  assert.equal(report.packaged, packaged)
  assert.equal(report.metadata.product, product)
  assert.equal(report.metadata.appId, `dev.matrix.${product}`)
  assert.equal(report.runtime.page, product)
  assert.equal(report.runtime.product.key, product)
  assert.equal(report.runtime.environment, environment)
  const suffix = environment === 'production' ? '' : environment === 'development' ? '-dev' : '-staging'
  assert.equal(report.runtime.config.apiBase, `https://${product}${suffix}.example.test`)
  for (const [scope, snapshot] of [['main', report.main], ['preload', report.preload], ['renderer', report.runtime]]) {
    assert.ok(snapshot, `${scope} must execute in the real Electron application`)
    assert.equal(snapshot.product.key, product)
    assert.equal(snapshot.environment, environment)
    assert.equal(snapshot.isDevelopment, !packaged)
    assert.equal(snapshot.config.enabled, false)
    assert.equal(snapshot.config.retryCount, product === 'alpha' ? 2 : 3)
    assert.equal(snapshot.config.apiBase, report.runtime.config.apiBase)
    assert.equal(Object.hasOwn(snapshot.config, 'mainOnly'), scope === 'main')
    assert.equal(Object.hasOwn(snapshot.config, 'preloadOnly'), scope === 'preload')
    if (scope !== 'renderer') {
      const scopeValue = scope === 'main' ? `${product}-main` : product === 'alpha' ? 101 : 202
      assert.equal(snapshot.config.scopeValue, scopeValue)
    }
    else {
      assert.equal(Object.hasOwn(snapshot.config, 'scopeValue'), false)
    }
  }
}

export async function verifyReport(output, result, product, environment, packaged) {
  try {
    assertReport(JSON.parse(await readFile(output, 'utf8')), product, environment, packaged)
  }
  catch (error) {
    console.error([
      `Electron acceptance report failed: product=${product}, environment=${environment}, phase=${packaged ? 'packaged' : 'development'}, exitCode=${result.exitCode}`,
      `Report: ${output}`,
      'Captured output:',
      result.all || '(no output captured)',
    ].join('\n'))
    throw error
  }
}
