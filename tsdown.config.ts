import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    plan: 'src/plan.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22.18',
  fixedExtension: false,
  outDir: 'dist',
  dts: true,
  sourcemap: false,
  minify: true,
  clean: true,
  unbundle: true,
  publint: true,
})
