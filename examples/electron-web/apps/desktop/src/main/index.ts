import path from 'node:path'
import process from 'node:process'
import { app, BrowserWindow } from 'electron'
import { matrix } from 'virtual:matrix/runtime/main'
import { reportRuntime } from '../../../../acceptance/report'

if (matrix.isDevelopment)
  void import('../../../../shared/dev-only')

const output = process.env.EXAMPLE_SMOKE_OUTPUT
if (output)
  app.commandLine.appendSwitch('disable-gpu')
if (process.platform === 'win32')
  app.setAppUserModelId(matrix.product.appId!)

const timeout = output ? setTimeout(() => app.exit(1), 20_000) : undefined
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    title: matrix.product.name,
    show: !output,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  if (app.isPackaged)
    await window.loadFile(path.join(__dirname, '../web/index.html'))
  else
    await window.loadURL(matrix.config.rendererUrl)
  if (output) {
    await reportRuntime(window, output, matrix, app.isPackaged)
    clearTimeout(timeout)
    app.quit()
  }
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
app.on('window-all-closed', () => app.quit())
process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())
