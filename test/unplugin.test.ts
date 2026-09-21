import { describe, expect, it } from 'vitest'
import { createMatrixRuntime, ensureMatrixEnvPrefix } from '../src/unplugin.js'

describe('matrix unplugin', () => {
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
})
