import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultEnvironmentForTarget, defineMatrixEnv, listMatrixEnvironments, loadMatrixConfig, MATRIX_DEFAULTS, normalizeMatrixConfig } from '../src/config.js'

describe('matrix config', () => {
  it('provides a c12-compatible shorthand for environment overrides', () => {
    expect(defineMatrixEnv({ staging: { API_BASE: 'https://staging.example.com' } })).toEqual({
      staging: { env: { API_BASE: 'https://staging.example.com' } },
    })
  })

  it('uses target defaults for the standard environments', () => {
    expect(MATRIX_DEFAULTS).toMatchObject({ target: 'dev', projectRoot: '.', outputDir: 'dist', artifactsRoot: 'artifacts' })
    expect(MATRIX_DEFAULTS.targets).toMatchObject({
      dev: { environment: 'development', continuous: true },
      build: { environment: 'production', continuous: false },
      preview: { environment: 'production', continuous: true },
    })
    expect(defaultEnvironmentForTarget('dev')).toBe('development')
    expect(defaultEnvironmentForTarget('build')).toBe('production')
    expect(defaultEnvironmentForTarget('preview')).toBe('production')
    expect(defaultEnvironmentForTarget('test')).toBe('development')
  })

  it('resolves custom c12 $env environments before planning', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-config-'))
    await fs.writeFile(path.join(cwd, 'matrix.config.mjs'), `export default {
      env: { API_BASE: 'http://localhost' },
      $env: { qa: { env: { API_BASE: 'https://qa.example.com', QA_ONLY: 'yes' } } },
      projects: { web: { targets: { dev: 'vite' } } },
      products: { app: { variants: { web: 'web' } } },
    }`)

    const loaded = await loadMatrixConfig({ cwd, envName: 'qa' })
    expect(loaded.config.env).toMatchObject({ API_BASE: 'https://qa.example.com', QA_ONLY: 'yes' })
    expect('$env' in loaded.config).toBe(false)
  })

  it('lists custom environments for interactive selection', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-environments-'))
    await fs.writeFile(path.join(cwd, 'matrix.config.mjs'), `export default {
      $env: { qa: { env: { API_BASE: 'https://qa.example.com' } } },
      projects: { web: { targets: { dev: 'vite' } } },
      products: {
        app: {
          $env: { preview: { env: { API_BASE: 'https://preview.example.com' } } },
          variants: { web: 'web' },
        },
      },
    }`)

    await expect(listMatrixEnvironments({ cwd })).resolves.toEqual(['development', 'staging', 'production', 'qa', 'preview'])
  })

  it('resolves product-specific $env overrides independently', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-product-env-'))
    await fs.writeFile(path.join(cwd, 'matrix.config.mjs'), `export default {
      projects: { web: { targets: { dev: 'vite' } } },
      products: {
        app: {
          env: { API_BASE: 'http://localhost' },
          $env: { staging: { env: { API_BASE: 'https://staging.example.com', PRODUCT_ONLY: 'yes' } } },
          variants: { web: 'web' },
        },
      },
    }`)

    const loaded = await loadMatrixConfig({ cwd, envName: 'staging' })
    expect(loaded.config.products.app?.env).toMatchObject({ API_BASE: 'https://staging.example.com', PRODUCT_ONLY: 'yes' })
    expect('$env' in (loaded.config.products.app ?? {})).toBe(false)
  })

  it('rejects archives on non-build targets', () => {
    expect(() => normalizeMatrixConfig({
      projects: {
        web: { targets: { test: { command: 'test', archive: true } } },
      },
      products: { app: { variants: { web: 'web' } } },
    })).toThrow('Archive is only supported for build targets: test')
  })
})
