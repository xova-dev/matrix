import process from 'node:process'
import { defineMatrixConfig, defineMatrixEnv } from '@xova/matrix'

const ports = {
  alpha: Number(process.env.EXAMPLE_ALPHA_PORT ?? 5410),
  beta: Number(process.env.EXAMPLE_BETA_PORT ?? 5420),
}

function webProject(name) {
  return {
    root: `./apps/web-${name}`,
    targets: {
      dev: { command: 'node ../../scripts/web.mjs dev', readyWhen: { type: 'port', port: ports[name] } },
      // Keep the web output available for the dependent desktop build.
      build: 'node ../../scripts/web.mjs build',
    },
  }
}

function product(name, label) {
  return {
    name: `Matrix ${label}`,
    appId: `dev.matrix.${name}`,
    env: {
      WEB_NAME: name,
      WEB_PORT: ports[name],
      WEB_URL: `http://127.0.0.1:${ports[name]}`,
      WEB_DIST_DIR: `../web-${name}/dist`,
      VITE_PRODUCT_LABEL: label,
      VITE_API_BASE: `https://${name}-dev.example.test`,
    },
    $env: defineMatrixEnv({
      staging: { VITE_API_BASE: `https://${name}-staging.example.test` },
      production: { VITE_API_BASE: `https://${name}.example.test` },
    }),
    variants: {
      web: `web-${name}`,
      desktop: { project: 'desktop', targets: { dev: { dependsOn: ['web'] }, build: { dependsOn: ['web'] } } },
    },
  }
}

export default defineMatrixConfig({
  projects: {
    'web-alpha': webProject('alpha'),
    'web-beta': webProject('beta'),
    'desktop': {
      root: './apps/desktop',
      prepare: ['node prepare.mjs'],
      targets: {
        dev: 'node dev.mjs',
        build: { command: 'node build.mjs', outputDir: 'release', artifacts: { mode: 'move' } },
      },
    },
  },
  products: { alpha: product('alpha', 'Alpha'), beta: product('beta', 'Beta') },
})
