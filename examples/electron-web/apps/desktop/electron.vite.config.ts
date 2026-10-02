import { resolve } from 'node:path'
import matrix from '@xova/matrix/vite'
import { defineConfig } from 'electron-vite'

// The renderer is a separate Matrix project with its own Vite build.
export default defineConfig({
  main: {
    plugins: [matrix({ scope: 'main' })],
    build: {
      outDir: 'dist/main',
      rollupOptions: { input: resolve('src/main/index.ts') },
    },
  },
  preload: {
    plugins: [matrix({ scope: 'preload' })],
    build: {
      outDir: 'dist/preload',
      externalizeDeps: false,
      rollupOptions: { input: resolve('src/preload/index.ts') },
    },
  },
})
