/* eslint-disable antfu/no-top-level-await -- Dedicated worker entrypoint; module errors must terminate the worker. */
import type { ConfigRequest, ConfigSnapshot } from './config-loader.js'
import type { MatrixConfig } from './types.js'
import process from 'node:process'
import { parentPort, workerData } from 'node:worker_threads'
import { loadConfig, loadDotenv } from 'c12'

const request = workerData as ConfigRequest & { schemaUrl: string }
const dotenv = { cwd: request.cwd, fileName: ['.env', '.env.local', `.env.${request.envName}`, `.env.${request.envName}.local`] }
// Track declarations independently of inherited Shell values, including overridden keys.
const dotenvKeys = request.discover ? [] : Object.keys(await loadDotenv({ ...dotenv, env: {}, interpolate: false }))
const loaded = await loadConfig<MatrixConfig>({
  name: 'matrix',
  cwd: request.cwd,
  ...(request.configFile ? { configFile: request.configFile } : {}),
  envName: request.discover ? false : request.envName,
  dotenv,
  omit$Keys: !request.discover,
  rcFile: false,
  packageJson: false,
})

if (request.discover) {
  const config = loaded.config
  const products = request.productName
    ? [config.products?.[request.productName]]
    : Object.values(config.products ?? {})
  parentPort!.postMessage([...new Set([
    ...Object.keys(config.$env ?? {}),
    ...products.flatMap(product => Object.keys(product?.$env ?? {})),
  ])])
}
else {
  const { assertMatrixConfig } = await import(request.schemaUrl) as typeof import('./schema.js')
  const result: ConfigSnapshot = {
    config: assertMatrixConfig(loaded.config) as MatrixConfig,
    configFile: loaded.configFile,
    // Layers are diagnostic data: retain a JSON snapshot, not executable helpers.
    layers: loaded.layers ? JSON.parse(JSON.stringify(loaded.layers)) : undefined,
    externalEnv: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    dotenvKeys,
  }
  parentPort!.postMessage(result)
}
