import { describe, expect, it } from 'vitest'
import { normalizeMatrixConfig } from '../src/config.js'
import { createExecutionPlan, validateExecutionGraph } from '../src/plan.js'

describe('matrix plan', () => {
  it('normalizes shorthand targets and variants and applies suffixes', () => {
    const { config, products } = normalizeMatrixConfig({
      suffixes: { test: { name: '（测试）', appId: '-test' } },
      projects: {
        web: { targets: { dev: 'vite', build: 'vite build', preview: 'vite preview' } },
        desktop: { targets: { dev: 'electron', build: 'electron-builder' } },
      },
      products: {
        classroom: {
          appId: 'com.example.classroom',
          variants: {
            web: 'web',
            desktop: {
              project: 'desktop',
              targets: {
                dev: { dependsOn: [{ variant: 'web' }] },
                build: { dependsOn: [{ variant: 'web' }] },
              },
            },
          },
        },
      },
    })
    const plan = createExecutionPlan({ config, projects: { web: {}, desktop: {} }, products, cwd: process.cwd(), productNames: ['classroom'], target: 'dev', envName: 'test' })
    expect(products.classroom?.variants.web?.targets.dev?.continuous).toBe(true)
    expect(products.classroom?.variants.web?.targets.preview?.continuous).toBe(true)
    expect(plan.tasks.map(task => task.id)).toEqual(['classroom:web:dev', 'classroom:desktop:dev'])
    expect(plan.tasks[1]?.env).toMatchObject({
      MATRIX_ENV_NAME: 'test',
      MATRIX_TARGET: 'dev',
      MATRIX_PRODUCT_KEY: 'classroom',
      MATRIX_PRODUCT_ID: 'classroom',
      MATRIX_PRODUCT_NAME: 'classroom（测试）',
      MATRIX_PRODUCT_SLUG: 'classroom',
      MATRIX_PRODUCT_APP_ID: 'com.example.classroom-test',
      MATRIX_VARIANT: 'desktop',
      MATRIX_PROJECT: 'desktop',
      NODE_ENV: 'development',
    })
    expect(plan.tasks[1]?.appId).toBe('com.example.classroom-test')
    expect(plan.tasks[1]?.dependsOn[0]).toEqual({ id: 'classroom:web:dev', condition: 'ready' })
    expect(products.classroom?.id).toBe('classroom')
    expect(products.classroom?.name).toBe('classroom')
  })

  it('scopes dependencies to the selected target and applies target overrides deeply', () => {
    const { config, products } = normalizeMatrixConfig({
      projects: {
        web: { targets: { build: { command: 'web-build' } } },
        desktop: { targets: { build: { command: 'desktop-build', archive: true } } },
      },
      products: {
        app: {
          variants: {
            web: 'web',
            desktop: { project: 'desktop', targets: { build: { dependsOn: ['web'] } } },
          },
        },
      },
    })
    const plan = createExecutionPlan({ config, projects: { web: {}, desktop: {} }, products, cwd: process.cwd(), productNames: ['app'], target: 'build', envName: 'development' })
    expect(plan.tasks.map(task => task.id)).toEqual(['app:web:build', 'app:desktop:build'])
    expect(plan.tasks[1]?.command).toBe('desktop-build')
    expect(plan.tasks[1]?.archive.enabled).toBe(true)
  })

  it('merges environment layers with external values taking precedence', () => {
    const { config, products } = normalizeMatrixConfig({
      env: { SOURCE: 'matrix', SHARED: 'base', MODE_ONLY: 'yes' },
      projects: { web: { targets: { dev: { command: 'vite' } } } },
      products: { app: { env: { PRODUCT_ONLY: 'yes', SHARED: 'product' }, variants: { web: 'web' } } },
    })
    const plan = createExecutionPlan({
      config,
      projects: { web: {} },
      products,
      externalEnv: { SHARED: 'shell', EXTERNAL_ONLY: 'yes' },
      cwd: process.cwd(),
      productNames: ['app'],
      target: 'dev',
      envName: 'test',
    })
    expect(plan.tasks[0]?.env).toMatchObject({ SOURCE: 'matrix', SHARED: 'shell', MODE_ONLY: 'yes', PRODUCT_ONLY: 'yes', EXTERNAL_ONLY: 'yes', MATRIX_ENV_NAME: 'test' })
  })

  it('resolves identity overrides before applying suffixes and protects Matrix identity fields', () => {
    const { config, products } = normalizeMatrixConfig({
      suffixes: { test: { name: '（测试）', slug: '-test', appId: '-test' } },
      projects: { desktop: { targets: { build: 'desktop-build' } } },
      products: {
        classroom: {
          appId: 'com.example.classroom',
          env: { MATRIX_PRODUCT_APP_ID: 'com.example.classroom-product' },
          variants: { desktop: 'desktop' },
        },
      },
    })
    const plan = createExecutionPlan({
      config,
      projects: { desktop: {} },
      products,
      externalEnv: {
        MATRIX_PRODUCT_APP_ID: 'com.example.classroom-local',
        MATRIX_PRODUCT_NAME: 'Classroom Local',
        MATRIX_PRODUCT_SLUG: 'classroom-local',
        MATRIX_PRODUCT_ID: 'overridden-id',
        NODE_ENV: 'development',
      },
      cwd: process.cwd(),
      productNames: ['classroom'],
      target: 'build',
      envName: 'test',
    })
    expect(plan.tasks[0]).toMatchObject({
      appId: 'com.example.classroom-local-test',
      name: 'Classroom Local（测试）',
      slug: 'classroom-local-test',
    })
    expect(plan.tasks[0]?.env).toMatchObject({
      MATRIX_PRODUCT_ID: 'classroom',
      MATRIX_PRODUCT_APP_ID: 'com.example.classroom-local-test',
      NODE_ENV: 'production',
    })
  })

  it('validates dependencies for every configured target', () => {
    const { config, projects, products } = normalizeMatrixConfig({
      projects: {
        web: { targets: { build: 'web-build' } },
        desktop: { targets: { build: 'desktop-build' } },
      },
      products: {
        app: {
          variants: {
            web: 'web',
            desktop: { project: 'desktop', targets: { build: { dependsOn: ['web'] } } },
          },
        },
      },
    })

    expect(() => validateExecutionGraph({ config, projects, products, cwd: process.cwd(), envName: 'production' })).not.toThrow()
  })

  it('rejects unknown dependency variants during graph validation', () => {
    const { config, projects, products } = normalizeMatrixConfig({
      projects: { web: { targets: { build: 'web-build' } } },
      products: {
        app: {
          variants: {
            web: { project: 'web', targets: { build: { dependsOn: ['missing'] } } },
          },
        },
      },
    })

    expect(() => validateExecutionGraph({ config, projects, products, cwd: process.cwd(), envName: 'production' }))
      .toThrow('Unknown dependency variant app/missing')
  })

  it('rejects dependency cycles during graph validation', () => {
    const { config, projects, products } = normalizeMatrixConfig({
      projects: {
        first: { targets: { build: { command: 'first-build', dependsOn: ['second'] } } },
        second: { targets: { build: { command: 'second-build', dependsOn: ['first'] } } },
      },
      products: {
        app: {
          variants: { first: 'first', second: 'second' },
        },
      },
    })

    expect(() => validateExecutionGraph({ config, projects, products, cwd: process.cwd(), envName: 'production' }))
      .toThrow('Dependency cycle detected at app:first:build')
  })
})
