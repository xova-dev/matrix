import { readFile } from 'node:fs/promises'
import http from 'node:http'
import process from 'node:process'

async function main() {
  // Read once before listening: missing output is an error, not a fake preview.
  const html = await readFile(new URL('./dist/index.html', import.meta.url))
  const port = 5311
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(html)
  })

  function shutdown() {
    server.close(() => process.exit(0))
  }

  server.listen(port, '127.0.0.1', () => {
    console.log(`Web preview server listening on http://127.0.0.1:${port}`)
  })
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
