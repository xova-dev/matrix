import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { defaultEnvironmentForTarget, defineMatrixEnv, listMatrixEnvironments, loadMatrixConfig, MATRIX_DEFAULTS, normalizeMatrixConfig } from '../src/config.js'
import { createExecutionPlan } from '../src/plan.js'
import { assertMatrixConfig } from '../src/schema.js'

describe('matrix config', () => {
  it('uses target defaults for the standard environments', () => {
    expect(MATRIX_DEFAULTS).toMatchObject({ target: 'dev', projectRoot: '.', outputDir: 'dist', artifactsRoot: 'artifacts' })
    expect(MATRIX_DEFAULTS.artifacts).toMatchObject({ mode: 'move', format: 'zip', clean: true })
    expect(MATRIX_DEFAULTS.targets).toMatchObject({
      dev: { environment: 'development', nodeEnv: 'development', continuous: true },
      build: { environment: 'production', nodeEnv: 'production', continuous: false },
      dist: { environment: 'production', nodeEnv: 'production', continuous: false },
      preview: { environment: 'production', nodeEnv: 'production', continuous: true },
      test: { environment: 'development', nodeEnv: 'test', continuous: false },
    })
    expect(defaultEnvironmentForTarget('dev')).toBe('development')
    expect(defaultEnvironmentForTarget('build')).toBe('production')
    expect(defaultEnvironmentForTarget('dist')).toBe('production')
    expect(defaultEnvironmentForTarget('preview')).toBe('production')
    expect(defaultEnvironmentForTarget('test')).toBe('development')
    const { products } = normalizeMatrixConfig({
      projects: { web: { targets: { test: 'pnpm test' } } },
      products: { app: { variants: { web: 'web' } } },
    })
    expect(products.app?.variants.web?.targets.test).toMatchObject({ nodeEnv: 'test', continuous: false })

    const distConfig = normalizeMatrixConfig({
      projects: { web: { targets: { dist: 'pnpm dist' } } },
      products: { app: { variants: { web: 'web' } } },
    })
    expect(distConfig.products.app?.variants.web?.targets.dist).toMatchObject({
      nodeEnv: 'production',
      continuous: false,
    })
  })

  it('resolves custom c12 $env environments before planning', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-config-'))
    await fs.writeFile(path.join(cwd, 'matrix.config.mjs'), `export default {
      env: { API_BASE: 'http://localhost' },
      $env: ${JSON.stringify(defineMatrixEnv({ qa: { API_BASE: 'https://qa.example.com', QA_ONLY: 'yes' } }))},
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

  it('isolates ESM and CommonJS config dependencies and preserves dotenv and shell precedence', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-scoped-env-'))
    const require = createRequire(import.meta.url)
    vi.stubEnv('MATRIX_CONFIG_ROOT', undefined)
    vi.stubEnv('MATRIX_CONFIG_DEV_ONLY', undefined)
    vi.stubEnv('MATRIX_CONFIG_SHELL', 'host-value')
    try {
      await fs.writeFile(path.join(cwd, '.env'), 'MATRIX_CONFIG_ROOT=base\nMATRIX_CONFIG_SHELL=file-value\n')
      await fs.writeFile(path.join(cwd, '.env.local'), 'MATRIX_CONFIG_ROOT=local\n')
      await fs.writeFile(path.join(cwd, '.env.development'), 'MATRIX_CONFIG_ROOT=development\nMATRIX_CONFIG_DEV_ONLY=dev\n')
      await fs.writeFile(path.join(cwd, '.env.development.local'), 'MATRIX_CONFIG_ROOT=dev-local\n')
      await fs.writeFile(path.join(cwd, '.env.staging'), 'MATRIX_CONFIG_ROOT=staging-app\n')
      await fs.writeFile(path.join(cwd, 'settings.cjs'), `module.exports = { root: process.env.MATRIX_CONFIG_ROOT, devOnly: process.env.MATRIX_CONFIG_DEV_ONLY ?? 'absent' }`)
      await fs.writeFile(path.join(cwd, 'settings.mjs'), `import settings from './settings.cjs'; export const root = settings.root; export const devOnly = settings.devOnly;`)
      const hostSettings = require(path.join(cwd, 'settings.cjs'))
      await fs.writeFile(path.join(cwd, 'matrix.config.mjs'), `
        import { root, devOnly } from './settings.mjs';
        if (!process.env.MATRIX_CONFIG_ROOT) throw new Error('Missing project root');
        export default {
          env: { SHELL_VALUE: process.env.MATRIX_CONFIG_SHELL, DEV_ONLY: devOnly },
          $env: { qa: { env: {} } },
          projects: { web: { root, targets: { build: 'echo build' } } },
          products: { app: { variants: { web: 'web' } } },
        }
      `)
      const development = await loadMatrixConfig({ cwd, envName: 'development' })
      expect(development.projects.web!.root).toBe('dev-local')
      expect(development.config.env).toMatchObject({ SHELL_VALUE: 'host-value', DEV_ONLY: 'dev' })
      const staging = await loadMatrixConfig({ cwd, envName: 'staging' })
      expect(staging.projects.web!.root).toBe('staging-app')
      expect(staging.config.env).toMatchObject({ SHELL_VALUE: 'host-value', DEV_ONLY: 'absent' })
      expect(staging.externalEnv).not.toHaveProperty('MATRIX_CONFIG_DEV_ONLY')
      expect(development.externalEnv.MATRIX_CONFIG_ROOT).toBe('dev-local')
      const plan = createExecutionPlan({ ...staging, productNames: ['app'], target: 'build' })
      expect(plan.tasks[0]!.cwd).toBe(path.join(cwd, 'staging-app'))
      expect(plan.tasks[0]!.env.MATRIX_CONFIG_ROOT).toBe('staging-app')
      await expect(listMatrixEnvironments({ cwd, envName: 'staging' })).resolves.toContain('qa')
      expect(process.env.MATRIX_CONFIG_ROOT).toBeUndefined()
      expect(process.env.MATRIX_CONFIG_DEV_ONLY).toBeUndefined()
      expect(process.env.MATRIX_CONFIG_SHELL).toBe('host-value')
      expect(require(path.join(cwd, 'settings.cjs'))).toBe(hostSettings)
      expect(hostSettings.root).toBeUndefined()
    }
    finally {
      delete require.cache[path.join(cwd, 'settings.cjs')]
      vi.unstubAllEnvs()
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })

  it('isolates concurrent async config evaluations and leaves the host untouched on failure', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-concurrent-env-'))
    vi.stubEnv('MATRIX_CONFIG_ROOT', undefined)
    try {
      for (const envName of ['development', 'broken', 'staging'])
        await fs.writeFile(path.join(cwd, `.env.${envName}`), `MATRIX_CONFIG_ROOT=${envName}\n`)
      await fs.writeFile(path.join(cwd, 'matrix.config.mjs'), `
        export default async () => {
          const before = process.env.MATRIX_CONFIG_ROOT;
          await new Promise(resolve => setTimeout(resolve, 20));
          if (before !== process.env.MATRIX_CONFIG_ROOT) throw new Error('Environment crossed evaluations');
          if (before === 'broken') throw new Error('Broken configuration');
          return {
            $env: { [before]: { env: {} } },
            projects: { web: { root: before, targets: { build: 'echo build' } } },
            products: { app: { variants: { web: 'web' } } },
          };
        };
      `)
      const [development, broken, staging, environments] = await Promise.allSettled([
        loadMatrixConfig({ cwd, envName: 'development' }),
        loadMatrixConfig({ cwd, envName: 'broken' }),
        loadMatrixConfig({ cwd, envName: 'staging' }),
        listMatrixEnvironments({ cwd, envName: 'staging' }),
      ])
      expect(development).toMatchObject({ status: 'fulfilled', value: { projects: { web: { root: 'development' } } } })
      expect(broken).toMatchObject({ status: 'rejected', reason: new Error('Broken configuration') })
      expect(staging).toMatchObject({ status: 'fulfilled', value: { projects: { web: { root: 'staging' } } } })
      expect(environments).toMatchObject({ status: 'fulfilled', value: ['development', 'staging', 'production'] })
      expect(process.env.MATRIX_CONFIG_ROOT).toBeUndefined()
    }
    finally {
      vi.unstubAllEnvs()
      await fs.rm(cwd, { recursive: true, force: true })
    }
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

  it('normalizes ordered target commands and artifact settings', () => {
    expect(() => normalizeMatrixConfig({
      projects: {
        web: { targets: { release: { command: ['build', 'package'], artifacts: { mode: 'move' } } } },
      },
      products: { app: { variants: { web: 'web' } } },
    })).not.toThrow()
    const { products } = normalizeMatrixConfig({
      projects: { web: { targets: { release: { command: ['build', 'package'], artifacts: { mode: 'move' } } } } },
      products: { app: { variants: { web: 'web' } } },
    })
    expect(products.app?.variants.web?.targets.release).toMatchObject({
      command: ['build', 'package'],
      artifacts: { mode: 'move', clean: true },
    })
  })

  it('does not enable artifact cleanup when artifacts are not configured', () => {
    const { products } = normalizeMatrixConfig({
      projects: { web: { targets: { test: 'test' } } },
      products: { app: { variants: { web: 'web' } } },
    })
    expect(products.app?.variants.web?.targets.test?.artifacts).toBeUndefined()
  })

  it('applies artifact defaults when a variant adds artifact delivery', () => {
    const { products } = normalizeMatrixConfig({
      projects: { web: { targets: { build: 'vite build' } } },
      products: {
        app: {
          variants: {
            web: { project: 'web', targets: { build: { artifacts: { mode: 'archive' } } } },
          },
        },
      },
    })
    expect(products.app?.variants.web?.targets.build?.artifacts).toEqual({ mode: 'archive', format: 'zip', clean: true })
  })

  it('accepts ordered command arrays as project target shorthand', () => {
    expect(() => assertMatrixConfig({
      projects: {
        web: { targets: { build: ['pnpm typecheck', 'pnpm exec vite build'] } },
      },
      products: { app: { variants: { web: 'web' } } },
    })).not.toThrow()
  })

  it('revalidates variant target overrides after merging defaults', () => {
    expect(() => normalizeMatrixConfig({
      projects: {
        web: { targets: { dev: { command: 'vite', continuous: true } } },
      },
      products: {
        app: {
          variants: {
            web: { project: 'web', targets: { dev: { command: ['prepare', 'vite'] } } },
          },
        },
      },
    })).toThrow('Continuous targets cannot use multiple commands')
  })

  it('rejects invalid readiness port and timeout values', () => {
    const config = {
      projects: {
        web: {
          targets: {
            dev: { command: 'dev', readyWhen: { type: 'port' as const, port: 0, timeout: 0 } },
          },
        },
      },
      products: { app: { variants: { web: 'web' } } },
    }

    expect(() => assertMatrixConfig(config)).toThrow()
  })
})
