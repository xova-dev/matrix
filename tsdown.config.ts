import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    plan: 'src/plan.ts',
    cli: 'src/cli.ts',
    vite: 'src/vite.ts',
    rollup: 'src/rollup.ts',
    webpack: 'src/webpack.ts',
    esbuild: 'src/esbuild.ts',
    runtime: 'src/runtime.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22.18',
  fixedExtension: false,
  outDir: 'dist',
  dts: true,
  deps: {
    dts: {
      neverBundle: true,
    },
  },
  sourcemap: false,
  minify: true,
  clean: true,
  unbundle: true,
  publint: true,
})
