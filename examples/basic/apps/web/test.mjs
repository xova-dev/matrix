import assert from 'node:assert/strict'
import process from 'node:process'

assert.equal(process.env.MATRIX_PROJECT, 'web', 'Run this check through Matrix')
assert.equal(process.env.MATRIX_PRODUCT_KEY, 'app')
assert.equal(process.env.MATRIX_PRODUCT_VERSION, '0.1.0')
assert.ok(process.env.MATRIX_ENV_NAME)
assert.ok(URL.canParse(process.env.VITE_API_BASE), 'Matrix must supply an API URL')
console.log('Web checks passed: product, version, environment and API context are available')
