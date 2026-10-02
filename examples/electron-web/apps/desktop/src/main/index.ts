import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { app, BrowserWindow } from 'electron'
import { matrix } from 'virtual:matrix/runtime/main'

const output = process.env.EXAMPLE_SMOKE_OUTPUT
const metadata = {
  product: matrix.product.key,
  name: matrix.product.name,
  appId: matrix.product.appId!,
  environment: matrix.environment,
  page: matrix.config.page,
  apiBase: matrix.config.apiBase,
  label: matrix.config.productLabel,
}

if (output)
  app.commandLine.appendSwitch('disable-gpu')
if (process.platform === 'win32')
  app.setAppUserModelId(metadata.appId)

const timeout = output ? setTimeout(() => app.exit(1), 20_000) : undefined
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    title: metadata.name,
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
    const { runtime, preload } = await window.webContents.executeJavaScript('({ runtime: window.example, preload: window.desktopRuntime })')
    assert.equal(runtime.page, metadata.page)
    assert.equal(runtime.product.key, metadata.product)
    assert.equal(runtime.product.appId, metadata.appId)
    assert.equal(runtime.environment, metadata.environment)
    assert.equal(runtime.config.apiBase, metadata.apiBase)
    assert.equal(runtime.config.productLabel, metadata.label)
    assert.equal(runtime.nodeEnv, app.isPackaged ? 'production' : 'development')
    writeFileSync(output, JSON.stringify({ metadata, runtime, main: matrix, preload, packaged: app.isPackaged }))
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
