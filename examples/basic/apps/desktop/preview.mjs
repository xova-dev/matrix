import http from 'node:http'
import process from 'node:process'

const port = 5321
const server = http.createServer((_request, response) => {
  response.end('Matrix Desktop preview endpoint\n')
})

function shutdown() {
  server.close(() => process.exit(0))
}

server.listen(port, '127.0.0.1', () => {
  console.log(`Desktop preview endpoint listening on http://127.0.0.1:${port}`)
})
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
