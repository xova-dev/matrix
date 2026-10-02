import process from 'node:process'
import { defineMatrixConfig, defineMatrixEnv } from '@xova/matrix'

const ports = {
  alpha: Number(process.env.EXAMPLE_ALPHA_PORT ?? 5410),
  beta: Number(process.env.EXAMPLE_BETA_PORT ?? 5420),
}

export default defineMatrixConfig({
  envSchema: {
    VITE_ENABLED: { type: 'boolean', default: false },
    VITE_RETRY_COUNT: { type: 'number' },
    MAIN_VITE_SCOPE_VALUE: { type: 'string' },
    PRELOAD_VITE_SCOPE_VALUE: { type: 'number' },
  },
  projects: {
    'web-alpha': {
      root: './apps/web-alpha',
      targets: {
        dev: { command: 'node ../../scripts/web.mjs dev', readyWhen: { type: 'port', port: ports.alpha } },
        // Keep the Web output available for the dependent Desktop build.
        build: 'node ../../scripts/web.mjs build',
      },
    },
    'web-beta': {
      root: './apps/web-beta',
      targets: {
        dev: { command: 'node ../../scripts/web.mjs dev', readyWhen: { type: 'port', port: ports.beta } },
        build: 'node ../../scripts/web.mjs build',
      },
    },
    'desktop': {
      root: './apps/desktop',
      prepare: 'node prepare.mjs',
      targets: {
        dev: 'node dev.mjs',
        build: { command: 'node build.mjs', outputDir: 'release', artifacts: { mode: 'move' } },
      },
    },
  },
  products: {
    alpha: {
      name: 'Matrix Alpha',
      appId: 'dev.matrix.alpha',
      env: {
        WEB_NAME: 'alpha',
        WEB_PORT: ports.alpha,
        WEB_DIST_DIR: '../web-alpha/dist',
        VITE_PRODUCT_LABEL: 'Alpha',
        VITE_API_BASE: 'https://alpha-dev.example.test',
        VITE_RETRY_COUNT: 2,
        MAIN_VITE_RENDERER_URL: `http://127.0.0.1:${ports.alpha}`,
        MAIN_VITE_PAGE: 'alpha',
        MAIN_VITE_SCOPE_VALUE: 'alpha-main',
        MAIN_VITE_MAIN_ONLY: 'main-only-alpha',
        PRELOAD_VITE_SCOPE_VALUE: 101,
        PRELOAD_VITE_PRELOAD_ONLY: 'preload-only-alpha',
      },
      $env: defineMatrixEnv({
        staging: { VITE_API_BASE: 'https://alpha-staging.example.test' },
        production: { VITE_API_BASE: 'https://alpha.example.test' },
      }),
      variants: {
        web: 'web-alpha',
        desktop: {
          project: 'desktop',
          targets: {
            dev: { dependsOn: ['web'] },
            build: { dependsOn: ['web'] },
          },
        },
      },
    },
    beta: {
      name: 'Matrix Beta',
      appId: 'dev.matrix.beta',
      env: {
        WEB_NAME: 'beta',
        WEB_PORT: ports.beta,
        WEB_DIST_DIR: '../web-beta/dist',
        VITE_PRODUCT_LABEL: 'Beta',
        VITE_API_BASE: 'https://beta-dev.example.test',
        VITE_RETRY_COUNT: 3,
        MAIN_VITE_RENDERER_URL: `http://127.0.0.1:${ports.beta}`,
        MAIN_VITE_PAGE: 'beta',
        MAIN_VITE_SCOPE_VALUE: 'beta-main',
        MAIN_VITE_MAIN_ONLY: 'main-only-beta',
        PRELOAD_VITE_SCOPE_VALUE: 202,
        PRELOAD_VITE_PRELOAD_ONLY: 'preload-only-beta',
      },
      $env: defineMatrixEnv({
        staging: { VITE_API_BASE: 'https://beta-staging.example.test' },
        production: { VITE_API_BASE: 'https://beta.example.test' },
      }),
      variants: {
        web: 'web-beta',
        desktop: {
          project: 'desktop',
          targets: {
            dev: { dependsOn: ['web'] },
            build: { dependsOn: ['web'] },
          },
        },
      },
    },
  },
})
