import { spawn } from 'node:child_process'
import net from 'node:net'
import process from 'node:process'

const ports = [5310, 5320]
const command = spawn(process.execPath, ['../../bin/matrix.mjs', 'dev', 'app'], {
  stdio: ['ignore', 'inherit', 'inherit'],
})

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (connected) => {
      if (settled)
        return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(250, () => finish(false))
  })
}

async function waitForPorts(expected) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await Promise.all(ports.map(canConnect))).every(value => value === expected))
      return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ports ${ports.join(', ')}`)
}

async function waitForExit() {
  const [code, signal] = await new Promise((resolve) => {
    command.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]))
  })
  if (signal || code !== 0)
    throw new Error(`Matrix did not exit cleanly: code=${code ?? 'null'} signal=${signal ?? 'none'}`)
}

try {
  await waitForPorts(true)
  command.kill('SIGINT')
  await waitForExit()
  await waitForPorts(false)
  console.log('Shutdown smoke test passed: Matrix waited for both development servers to exit.')
}
catch (error) {
  if (!command.killed)
    command.kill('SIGKILL')
  console.error(error)
  process.exitCode = 1
}
