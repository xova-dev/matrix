import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const desktop = fileURLToPath(new URL('../apps/desktop/', import.meta.url))

function check(scope, virtualFiles = {}) {
  const configPath = path.join(desktop, `tsconfig.${scope}.json`)
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, desktop)
  assert.deepEqual(parsed.errors, [])
  const host = ts.createCompilerHost(parsed.options)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.readFile = file => virtualFiles[file] ?? readFile(file)
  host.fileExists = file => Object.hasOwn(virtualFiles, file) || fileExists(file)
  const program = ts.createProgram([...parsed.fileNames, ...Object.keys(virtualFiles)], parsed.options, host)
  return ts.getPreEmitDiagnostics(program)
}

function assertValid(diagnostics) {
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => desktop,
    getNewLine: () => '\n',
  }))
}

// Acceptance-only probes use the actual generated declarations.
for (const [scope, own, other, valueType] of [
  ['main', 'mainOnly', 'preloadOnly', 'string'],
  ['preload', 'preloadOnly', 'mainOnly', 'number'],
]) {
  const moduleId = `virtual:matrix/runtime/${scope}`
  const consumer = [
    `import { matrix } from '${moduleId}';`,
    `const value: ${valueType} = matrix.config.scopeValue;`,
    `const own: string = matrix.config.${own};`,
    'const enabled: boolean = matrix.config.enabled;',
    'const count: number = matrix.config.retryCount;',
    '// @ts-expect-error The other scope must not be exposed.',
    `matrix.config.${other};`,
    '// @ts-expect-error Scalar config types must not widen to any.',
    `const wrong: ${valueType === 'string' ? 'number' : 'string'} = matrix.config.scopeValue;`,
    '// @ts-expect-error The config snapshot is read-only.',
    'matrix.config.enabled = true;',
  ].join('\n')
  assertValid(check(scope, { [path.join(desktop, `probe-${scope}.ts`)]: consumer }))
}

console.log('Types verified: both virtual modules coexist with scope-specific fields, scalar types, and read-only config.')
