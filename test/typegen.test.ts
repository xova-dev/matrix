import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { generateMatrixTypes, matrixRuntimeModuleId } from '../src/typegen.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('matrix type generation', () => {
  it('generates typed public env and virtual runtime declarations without values', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'matrix-types-'))
    temporaryDirectories.push(project)
    const output = await generateMatrixTypes({
      cwd: project,
      env: {
        VITE_API_BASE: 'https://secret-value.example.com',
        MATRIX_PRODUCT_NAME: 'App',
        API_SECRET: 'do-not-type-as-public',
      },
    })
    const declaration = await readFile(output, 'utf8')
    expect(declaration).toMatch(/^\/\* eslint-disable \*\//)
    expect(declaration).toContain('/* prettier-ignore */')
    expect(declaration).toContain('// oxfmt-ignore')
    expect(declaration).not.toContain('// @ts-nocheck')
    expect(declaration).toContain('readonly VITE_API_BASE: string')
    expect(declaration).toContain('readonly apiBase: string')
    expect(declaration).toContain('MatrixRuntime<MatrixConfig>')
    expect(declaration).not.toContain('secret-value.example.com')
    expect(declaration).not.toContain('API_SECRET')
  })

  it('typechecks coexisting scopes without module-resolution overrides or skipped declaration checks', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'matrix-types-'))
    temporaryDirectories.push(project)
    const output = await generateMatrixTypes({
      cwd: project,
      scope: 'main',
      env: { MAIN_VITE_WINDOW_TITLE: 'Matrix' },
      envPrefix: ['MAIN_VITE_'],
    })
    const declaration = await readFile(output, 'utf8')
    expect(output).toBe(path.join(project, '.matrix/types/matrix-runtime-main.d.ts'))
    expect(declaration).toContain('declare module \'virtual:matrix/runtime/main\'')
    expect(matrixRuntimeModuleId('renderer')).toBe('virtual:matrix/runtime/renderer')
    const renderer = await generateMatrixTypes({
      cwd: project,
      scope: 'renderer',
      env: { VITE_WINDOW_TITLE: '123' },
      envSchema: { VITE_WINDOW_TITLE: { type: 'number' } },
    })
    const consumer = path.join(project, 'consumer.ts')
    await writeFile(consumer, [
      'import { matrix as main } from "virtual:matrix/runtime/main";',
      'import { matrix as renderer } from "virtual:matrix/runtime/renderer";',
      'const title: string = main.config.windowTitle;',
      'const numeric: number = renderer.config.windowTitle;',
      '// @ts-expect-error Scope-specific types must not merge or become any.',
      'const wrong: string = renderer.config.windowTitle;',
    ].join('\n'))
    const program = ts.createProgram([output, renderer, consumer], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
      // Resolve the package's own public type entry before the build step.
      paths: { '@xova/matrix/runtime': [fileURLToPath(new URL('../src/runtime.ts', import.meta.url))] },
    })
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  })
})
