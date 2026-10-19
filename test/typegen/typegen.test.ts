import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'pathe'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { generateMatrixTypes, matrixRuntimeModuleId, renderMatrixTypes } from '../../src/typegen/generate.js'

import { mergePreparedTypes } from '../../src/typegen/prepare.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('matrix type generation', () => {
  it('marks inferred fields absent from a product or context optional without weakening schema', () => {
    const common = {
      cwd: '/shared',
      envSchema: {
        VITE_REQUIRED: { type: 'number' as const },
        VITE_DEFAULT: { type: 'boolean' as const, default: false },
        VITE_OPTIONAL: { type: 'string' as const, optional: true },
      },
    }
    const batches = [
      [{ ...common, env: { VITE_ALPHA: '', VITE_SHARED: '', VITE_REQUIRED: '' } }],
      [{ ...common, env: { VITE_BETA: '', VITE_SHARED: '' } }],
    ]
    const declarations = mergePreparedTypes(batches).map(renderMatrixTypes)
    expect(mergePreparedTypes([...batches].reverse()).map(renderMatrixTypes)).toEqual(declarations)
    const declaration = declarations[0]!
    for (const field of ['alpha?: string', 'beta?: string', 'shared: string', 'required: number', 'default: boolean', 'optional?: string', 'VITE_ALPHA?: string'])
      expect(declaration).toContain(`readonly ${field}`)
    const cleared = mergePreparedTypes([[{ ...common, env: {} }]]).map(renderMatrixTypes)[0]!
    expect(cleared).not.toContain('alpha')
    expect(cleared).not.toContain('beta')
  })

  it('reconciles global raw env presence without merging scoped config contracts', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'matrix-scoped-types-'))
    temporaryDirectories.push(project)
    const main = {
      cwd: path.join(project, 'main'),
      typeProjectRoot: project,
      scope: 'main',
      env: { VITE_CONTEXT: '', VITE_MAIN_ONLY: '', VITE_ALWAYS: '' },
      envSchema: {
        VITE_TYPED: { type: 'enum' as const, values: ['main', 'worker'] as const },
        VITE_DEFAULT: { type: 'boolean' as const, default: false },
      },
    }
    const renderer = {
      cwd: path.join(project, 'renderer'),
      typeProjectRoot: project,
      scope: 'renderer',
      env: { VITE_CONTEXT: '', VITE_ALWAYS: '' },
      envSchema: {
        VITE_TYPED: { type: 'number' as const },
        VITE_DEFAULT: { type: 'string' as const, optional: true },
      },
    }
    const batches = [[main, renderer], [main, { ...renderer, env: { VITE_ALWAYS: '' } }]]
    const declarations = mergePreparedTypes(batches)
    const rendered = declarations.map(renderMatrixTypes)
    expect(mergePreparedTypes([...batches].reverse()).map(renderMatrixTypes)).toEqual(rendered)
    for (const declaration of rendered) {
      expect(declaration).toContain('readonly VITE_CONTEXT?: string')
      expect(declaration).toContain('readonly VITE_DEFAULT?: string')
      expect(declaration).toContain('readonly VITE_ALWAYS: string')
      expect(declaration).toContain('readonly VITE_TYPED: string')
    }
    expect(rendered[0]).toContain('readonly VITE_MAIN_ONLY?: string')
    expect(rendered[0]).toContain('readonly mainOnly: string')
    expect(rendered[0]).toContain('readonly context: string')
    expect(rendered[1]).toContain('readonly context?: string')
    expect(rendered[1]).not.toContain('mainOnly')
    expect(rendered[1]).not.toContain('VITE_MAIN_ONLY')
    const aliased = mergePreparedTypes(batches.map(batch => batch.map(declaration => ({
      ...declaration,
      typeProjectRoot: declaration.scope === 'renderer' ? renderer.cwd : project,
    }))))
    expect(aliased.map(renderMatrixTypes)).toEqual(rendered)
    const reowned = [...batches, [
      { ...main, typeProjectRoot: main.cwd },
      { ...renderer, typeProjectRoot: renderer.cwd, env: { VITE_ALWAYS: '' } },
    ]]
    // Later aliases can replace all output contributors; retain the original
    // parent ownership when reconciling globals, regardless of batch order.
    expect(mergePreparedTypes(reowned).map(renderMatrixTypes)).toEqual(rendered)
    expect(mergePreparedTypes([...reowned].reverse()).map(renderMatrixTypes)).toEqual(rendered)
    const outputs = await Promise.all(declarations.map(declaration => generateMatrixTypes(declaration)))
    const consumer = path.join(project, 'consumer.ts')
    await writeFile(consumer, [
      'import { matrix as main } from "virtual:matrix/runtime/main";',
      'import { matrix as renderer } from "virtual:matrix/runtime/renderer";',
      'declare const raw: ImportMetaEnv;',
      'const common: string = raw.VITE_ALWAYS;',
      'const rawTyped: string = raw.VITE_TYPED;',
      'const scoped: string = main.config.context;',
      'const mainOnly: string = main.config.mainOnly;',
      'const defaulted: boolean = main.config.default;',
      'const mainTyped: "main" | "worker" = main.config.typed;',
      'const rendererTyped: number = renderer.config.typed;',
      'const rendererDefault: string | undefined = renderer.config.default;',
      '// @ts-expect-error A key missing in one scope is globally optional.',
      'const unsafeMain: string = raw.VITE_MAIN_ONLY;',
      '// @ts-expect-error A key missing in one product/context is globally optional.',
      'const unsafeContext: string = raw.VITE_CONTEXT;',
      '// @ts-expect-error Schema optionality differs across scopes.',
      'const unsafeDefault: string = raw.VITE_DEFAULT;',
      '// @ts-expect-error Renderer context remains optional.',
      'const unsafeRenderer: string = renderer.config.context;',
      '// @ts-expect-error Main-only config must not leak into renderer.',
      'renderer.config.mainOnly;',
    ].join('\n'))
    const program = ts.createProgram([...outputs, consumer], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
      paths: { '@xova/matrix/runtime': [fileURLToPath(new URL('../../src/runtime/index.ts', import.meta.url))] },
    })
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
    const separate = mergePreparedTypes([[main, { ...renderer, cwd: `${project}-separate`, typeProjectRoot: `${project}-separate`, env: {} }]])
    expect(renderMatrixTypes(separate[0]!)).toContain('readonly VITE_CONTEXT: string')
  })

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
      '// @ts-expect-error The snapshot root cannot be changed.',
      'main.isDevelopment = true;',
      '// @ts-expect-error Product identity is immutable.',
      'main.product.name = "changed";',
      '// @ts-expect-error Public configuration is immutable.',
      'main.config.windowTitle = "changed";',
      '// @ts-expect-error Nested objects cannot be replaced.',
      'main.config = { windowTitle: "changed" };',
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
      paths: { '@xova/matrix/runtime': [fileURLToPath(new URL('../../src/runtime/index.ts', import.meta.url))] },
    })
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  })
})
