import { defineMatrixConfig, defineMatrixEnv } from '../../src/config.ts'

export default defineMatrixConfig({
  projects: {
    web: {
      root: './apps/web',
      targets: {
        dev: { command: 'node dev.mjs', readyWhen: { type: 'port', port: 5310 } },
        build: { command: 'node build.mjs', archive: true },
        preview: { command: 'node preview.mjs', readyWhen: { type: 'port', port: 5311 } },
        test: 'node test.mjs',
      },
    },
    desktop: {
      root: './apps/desktop',
      targets: {
        dev: { command: 'node dev.mjs', readyWhen: { type: 'port', port: 5320 } },
        build: { command: 'node build.mjs', archive: { enabled: true, format: 'tar.gz' } },
        preview: { command: 'node preview.mjs', readyWhen: { type: 'port', port: 5321 } },
        test: 'node test.mjs',
      },
    },
  },
  products: {
    app: {
      id: 'app',
      name: 'Matrix App',
      slug: 'matrix-app',
      appId: 'com.example.matrix',
      env: { VITE_API_BASE: 'http://localhost:3000' },
      $env: defineMatrixEnv({
        qa: { VITE_API_BASE: 'https://qa-api.example.com' },
        staging: { VITE_API_BASE: 'https://staging-api.example.com' },
        production: { VITE_API_BASE: 'https://api.example.com' },
      }),
      suffixes: {
        qa: { name: ' (QA)', slug: '-qa', appId: '.qa' },
        staging: { name: ' (Staging)', slug: '-staging', appId: '.staging' },
      },
      variants: {
        web: 'web',
        desktop: {
          project: 'desktop',
          name: 'Desktop App',
          appId: 'com.example.matrix.desktop',
          targets: {
            dev: { dependsOn: ['web'] },
            build: { dependsOn: ['web'] },
          },
        },
      },
    },
  },
})
