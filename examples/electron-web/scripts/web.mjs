import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import matrix from '@xova/matrix/vite'
import { build, createServer } from 'vite'

const config = {
  configFile: false,
  root: process.cwd(),
  base: './',
  plugins: [matrix()],
  build: { outDir: 'dist', emptyOutDir: true },
}

async function marker(state) {
  if (process.env.EXAMPLE_RUN_DIR)
    await writeFile(path.join(process.env.EXAMPLE_RUN_DIR, `web-${process.env.WEB_NAME}.${state}`), String(process.pid))
}

if (process.argv[2] === 'build') {
  await build(config)
}
else {
  const server = await createServer({ ...config, server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT), strictPort: true } })
  await server.listen()
  await marker('started')
  server.printUrls()
  let closing = false
  const close = async () => {
    if (closing)
      return
    closing = true
    await server.close()
    await marker('closed')
  }
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
}
