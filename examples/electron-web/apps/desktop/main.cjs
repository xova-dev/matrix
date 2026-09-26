const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const process = require('node:process')
const { app, BrowserWindow } = require('electron')

const output = process.env.EXAMPLE_SMOKE_OUTPUT
const metadata = app.isPackaged
  ? JSON.parse(fs.readFileSync(path.join(__dirname, 'matrix-product.json'), 'utf8'))
  : {
      product: process.env.MATRIX_PRODUCT_KEY,
      name: process.env.MATRIX_PRODUCT_NAME,
      appId: process.env.MATRIX_PRODUCT_APP_ID,
      environment: process.env.MATRIX_ENV_NAME,
      page: process.env.WEB_NAME,
      apiBase: process.env.VITE_API_BASE,
      label: process.env.VITE_PRODUCT_LABEL,
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
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  if (app.isPackaged)
    await window.loadFile(path.join(__dirname, 'web/index.html'))
  else
    await window.loadURL(process.env.WEB_URL)
  if (output) {
    const runtime = await window.webContents.executeJavaScript('window.example')
    assert.equal(runtime.page, metadata.page)
    assert.equal(runtime.product.key, metadata.product)
    assert.equal(runtime.product.appId, metadata.appId)
    assert.equal(runtime.environment, metadata.environment)
    assert.equal(runtime.config.apiBase, metadata.apiBase)
    assert.equal(runtime.config.productLabel, metadata.label)
    assert.equal(runtime.nodeEnv, app.isPackaged ? 'production' : 'development')
    fs.writeFileSync(output, JSON.stringify({ metadata, runtime, packaged: app.isPackaged }))
    clearTimeout(timeout)
    app.exit(0)
  }
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
app.on('window-all-closed', () => app.quit())
process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())
