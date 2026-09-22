import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMatrixRuntime, ensureMatrixEnvPrefix, MatrixUnplugin } from '../src/unplugin.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('matrix unplugin', () => {
  it('does not overwrite types from a Vitest config by default', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'matrix-vitest-types-'))
    temporaryDirectories.push(project)
    const plugin = MatrixUnplugin.vite()
    const configResolved = (Array.isArray(plugin) ? plugin : [plugin]).find(plugin => plugin.configResolved)?.configResolved
    if (configResolved) {
      const handler = typeof configResolved === 'function' ? configResolved : configResolved.handler
      await handler.call({} as never, {
        root: project,
        env: { MAIN_VITE_WINDOW_TITLE: 'Matrix' },
        envPrefix: ['MAIN_VITE_', 'MATRIX_', 'NODE_'],
      } as never)
    }

    await expect(readFile(path.join(project, '.matrix/types/matrix-runtime.d.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows explicitly generating types from a Vitest config', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'matrix-vitest-types-'))
    temporaryDirectories.push(project)
    const plugin = MatrixUnplugin.vite({ types: true })
    const configResolved = (Array.isArray(plugin) ? plugin : [plugin]).find(plugin => plugin.configResolved)?.configResolved
    if (configResolved) {
      const handler = typeof configResolved === 'function' ? configResolved : configResolved.handler
      await handler.call({} as never, {
        root: project,
        env: { MAIN_VITE_WINDOW_TITLE: 'Matrix' },
        envPrefix: ['MAIN_VITE_', 'MATRIX_', 'NODE_'],
      } as never)
    }

    await expect(readFile(path.join(project, '.matrix/types/matrix-runtime.d.ts'), 'utf8')).resolves.toContain('MAIN_VITE_WINDOW_TITLE')
  })

  it('adds the reserved Matrix prefix without removing host prefixes', () => {
    expect(ensureMatrixEnvPrefix(['MAIN_VITE_', 'MATRIX_'])).toEqual(['MAIN_VITE_', 'MATRIX_'])
    expect(ensureMatrixEnvPrefix(undefined)).toEqual(['VITE_', 'MATRIX_'])
  })

  it('maps exposed prefixed variables into structured runtime config', () => {
    expect(createMatrixRuntime({
      MATRIX_ENV_NAME: 'staging',
      MATRIX_TARGET: 'build',
      MATRIX_PRODUCT_KEY: 'app',
      MATRIX_PRODUCT_ID: 'app',
      MATRIX_PRODUCT_NAME: 'Matrix App',
      MATRIX_PRODUCT_SLUG: 'matrix-app',
      MATRIX_PRODUCT_APP_ID: 'com.example.matrix',
      MATRIX_VARIANT: 'desktop',
      MATRIX_PROJECT: 'desktop',
      NODE_ENV: 'production',
      VITE_API_BASE: 'https://api.example.com',
      MAIN_VITE_WINDOW_TITLE: 'Matrix',
      API_SECRET: 'do-not-expose',
    }, ['VITE_', 'MAIN_VITE_', 'MATRIX_'])).toEqual({
      environment: 'staging',
      target: 'build',
      nodeEnv: 'production',
      isDevelopment: false,
      isProduction: true,
      isTest: false,
      variant: 'desktop',
      project: 'desktop',
      product: {
        key: 'app',
        id: 'app',
        name: 'Matrix App',
        slug: 'matrix-app',
        appId: 'com.example.matrix',
      },
      config: {
        apiBase: 'https://api.example.com',
        windowTitle: 'Matrix',
      },
    })
  })

  it.each([
    ['development', true, false, false],
    ['dev', true, false, false],
    ['test', true, false, true],
    ['production', false, true, false],
    ['custom', true, false, false],
  ])('derives runtime mode flags from NODE_ENV=%s', (nodeEnv, isDevelopment, isProduction, isTest) => {
    expect(createMatrixRuntime({ NODE_ENV: nodeEnv })).toMatchObject({ isDevelopment, isProduction, isTest })
  })

  it('falls back to the Matrix-prefixed node environment used by Vite', () => {
    expect(createMatrixRuntime({ MATRIX_NODE_ENV: 'production' })).toMatchObject({
      nodeEnv: 'production',
      isDevelopment: false,
      isProduction: true,
      isTest: false,
    })
  })
})
