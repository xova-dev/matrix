import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'config': 'src/config/index.ts',
    'config-worker': 'src/config/worker.ts',
    'prepare-types-worker': 'src/typegen/worker.ts',
    'plan': 'src/execution/plan.ts',
    'cli': 'src/cli/index.ts',
    'vite': 'src/unplugin/vite.ts',
    'rollup': 'src/unplugin/rollup.ts',
    'webpack': 'src/unplugin/webpack.ts',
    'webpack-loader': 'src/unplugin/webpack-loader.ts',
    'esbuild': 'src/unplugin/esbuild.ts',
    'runtime': 'src/runtime/index.ts',
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
