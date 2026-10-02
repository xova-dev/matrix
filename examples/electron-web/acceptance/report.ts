import type { BrowserWindow } from 'electron'
import type { matrix } from 'virtual:matrix/runtime/main'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

/** Only called when EXAMPLE_SMOKE_OUTPUT explicitly enables acceptance. */
export async function reportRuntime(window: BrowserWindow, output: string, main: typeof matrix, packaged: boolean): Promise<void> {
  const metadata = {
    product: main.product.key,
    name: main.product.name,
    appId: main.product.appId,
    environment: main.environment,
    page: main.config.page,
    apiBase: main.config.apiBase,
    label: main.config.productLabel,
  }
  const { runtime, preload } = await window.webContents.executeJavaScript('({ runtime: window.example, preload: window.desktopRuntime })')
  assert.equal(runtime.page, metadata.page)
  assert.equal(runtime.product.key, metadata.product)
  assert.equal(runtime.product.appId, metadata.appId)
  assert.equal(runtime.environment, metadata.environment)
  assert.equal(runtime.config.apiBase, metadata.apiBase)
  assert.equal(runtime.config.productLabel, metadata.label)
  assert.equal(runtime.nodeEnv, packaged ? 'production' : 'development')
  writeFileSync(output, JSON.stringify({ metadata, runtime, main, preload, packaged }))
}
