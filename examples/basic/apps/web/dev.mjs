import http from 'node:http'
import process from 'node:process'

const port = 5310
const server = http.createServer((_request, response) => {
  response.end('Matrix Web development server\n')
})

function shutdown() {
  server.close(() => process.exit(0))
}

server.listen(port, '127.0.0.1', () => {
  console.log(`Web development server listening on http://127.0.0.1:${port}`)
})
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
