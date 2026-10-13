import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { execa } from 'execa'
import { afterEach, expect, it, vi } from 'vitest'
import { verifyReport } from '../../examples/electron-web/acceptance/verify-report.mjs'

const directories = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function launch(report) {
  const directory = await mkdtemp(join(tmpdir(), 'matrix electron report-'))
  directories.push(directory)
  const output = join(directory, 'report.json')
  // A real command can exit successfully despite failing to produce a usable report.
  const result = await execa(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs'
    console.log('wrapper: execution succeeded')
    console.error('electron: diagnostic from stderr')
    ${report === undefined ? '' : `writeFileSync(process.argv[1], ${JSON.stringify(report)})`}
  `, output], { all: true, env: { MATRIX_REPORT_TEST_SECRET: 'private-env-not-output' } })
  return { output, result }
}

function report(product, environment, packaged) {
  const suffix = environment === 'production' ? '' : environment === 'development' ? '-dev' : '-staging'
  const snapshot = scope => ({
    product: { key: product },
    environment,
    isDevelopment: !packaged,
    config: {
      enabled: false,
      retryCount: product === 'alpha' ? 2 : 3,
      apiBase: `https://${product}${suffix}.example.test`,
      ...(scope === 'main' ? { mainOnly: true, scopeValue: `${product}-main` } : {}),
      ...(scope === 'preload' ? { preloadOnly: true, scopeValue: product === 'alpha' ? 101 : 202 } : {}),
    },
  })
  return {
    packaged,
    metadata: { product, appId: `dev.matrix.${product}` },
    main: snapshot('main'),
    preload: snapshot('preload'),
    runtime: { ...snapshot('renderer'), page: product },
  }
}

it.each([
  ['alpha', 'development', false],
  ['beta', 'production', true],
])('diagnoses a missing %s / %s report after exit 0', async (product, environment, packaged) => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { output, result } = await launch()
  await expect(verifyReport(output, result, product, environment, packaged)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(result.exitCode).toBe(0)
  expect(errorLog).toHaveBeenCalledOnce()
  const diagnostic = errorLog.mock.calls[0].join('\n')
  expect(diagnostic).toContain(`product=${product}`)
  expect(diagnostic).toContain(`environment=${environment}`)
  expect(diagnostic).toContain(`phase=${packaged ? 'packaged' : 'development'}`)
  expect(diagnostic).toContain('exitCode=0')
  expect(diagnostic).toContain(output)
  expect(diagnostic).toContain('wrapper: execution succeeded')
  expect(diagnostic).toContain('electron: diagnostic from stderr')
  expect(diagnostic).not.toContain('private-env-not-output')
})

it.each([
  ['{"packaged":', 'SyntaxError'],
  ['null', 'TypeError'],
])('diagnoses an invalid report %s without replacing its error', async (contents, name) => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { output, result } = await launch(contents)
  await expect(verifyReport(output, result, 'alpha', 'staging', true)).rejects.toMatchObject({ name })
  expect(errorLog).toHaveBeenCalledOnce()
  expect(errorLog.mock.calls[0].join('\n')).toContain(result.all)
})

it('retains assertion failures and captured output for a parsed but incorrect report', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  const invalid = report('alpha', 'development', false)
  invalid.preload.config.scopeValue = '101'
  const { output, result } = await launch(JSON.stringify(invalid))
  await expect(verifyReport(output, result, 'alpha', 'development', false)).rejects.toMatchObject({
    name: 'AssertionError',
    actual: '101',
    expected: 101,
  })
  expect(errorLog).toHaveBeenCalledOnce()
  expect(errorLog.mock.calls[0].join('\n')).toContain(result.all)
})

it('identifies an empty command capture explicitly', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { output } = await launch()
  const result = await execa(process.execPath, ['-e', ''], { all: true })
  await expect(verifyReport(output, result, 'alpha', 'development', false)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(errorLog.mock.calls[0].join('\n')).toContain('(no output captured)')
})

it.each([
  ['alpha', 'development', false],
  ['beta', 'development', false],
  ['alpha', 'staging', true],
  ['beta', 'production', true],
  ['alpha', 'production', true],
])('keeps a valid %s / %s report quiet', async (product, environment, packaged) => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  const infoLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  const { output, result } = await launch(JSON.stringify(report(product, environment, packaged)))
  await expect(verifyReport(output, result, product, environment, packaged)).resolves.toBeUndefined()
  expect(errorLog).not.toHaveBeenCalled()
  expect(infoLog).not.toHaveBeenCalled()
})
