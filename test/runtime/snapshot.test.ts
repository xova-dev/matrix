import { describe, expect, it } from 'vitest'
import { ensureMatrixEnvPrefix } from '../../src/runtime/public-env.js'
import { createMatrixRuntime } from '../../src/runtime/snapshot.js'

describe('matrix runtime snapshot', () => {
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
    ['VITE_API_BASE', 'NUXT_PUBLIC_API_BASE', 'apiBase'],
    ['NUXT_PUBLIC_API_BASE', 'NUXT_PUBLIC_API__BASE', 'apiBase'],
    ['APP_API_BASE', 'VITE_API_BASE', 'apiBase'],
  ])('rejects strict public aliases %s / %s without leaking values', (first, second, field) => {
    for (const secondValue of ['FIRST_PRIVATE_VALUE', 'SECOND_PRIVATE_VALUE']) {
      const env = { [first]: 'FIRST_PRIVATE_VALUE', [second]: secondValue }
      const create = (): unknown => createMatrixRuntime(env, ['VITE_', 'NUXT_PUBLIC_', 'APP_'], {}, true)
      expect(create).toThrow(new RegExp(`^Ambiguous environment fields ${[first, second].sort().join(' and ')}: both map to matrix\\.config\\.${field}$`))
    }
  })

  it('keeps bare Vite defaults narrow and legacy alias behavior unchanged', () => {
    expect(createMatrixRuntime({ VITE_API_BASE: 'vite', NUXT_PUBLIC_API_BASE: 'nuxt' }).config).toEqual({ apiBase: 'vite' })
    expect(createMatrixRuntime({ VITE_API_BASE: 'vite', APP_API_BASE: 'app' }, ['VITE_', 'APP_']).config).toEqual({ apiBase: 'vite' })
  })

  it('preserves schema defaults and current-value precedence within prepared exposure', () => {
    const schema = {
      VITE_LIMIT: { type: 'number' as const, default: 3 },
      VITE_OPTIONAL: { type: 'string' as const, optional: true },
    }
    const preparedKeys = ['VITE_LIMIT', 'VITE_OPTIONAL', 'VITE_OTHER_PRODUCT']
    const env = { VITE_HOST_ONLY: 'host-value', PRIVATE_VALUE: 'private-value' }
    expect(createMatrixRuntime(env, ['VITE_'], schema, false, preparedKeys).config).toEqual({ limit: 3 })
    expect(createMatrixRuntime({ ...env, VITE_LIMIT: '0' }, ['VITE_'], schema, false, preparedKeys).config).toEqual({ limit: 0 })
    expect(() => createMatrixRuntime({ ...env, VITE_LIMIT: 'invalid' }, ['VITE_'], schema, false, preparedKeys))
      .toThrow('Invalid environment field VITE_LIMIT: expected number')
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
