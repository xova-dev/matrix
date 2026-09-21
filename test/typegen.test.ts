import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

  it('isolates declarations and virtual modules by scope', async () => {
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
  })
})
