import type { EnvMap, MatrixConfig } from './types.js'
import process from 'node:process'
import { Worker } from 'node:worker_threads'

export interface ConfigRequest {
  cwd: string
  envName: string
  configFile?: string
  productName?: string
  discover?: boolean
  signal?: AbortSignal
}

export interface ConfigSnapshot {
  config: MatrixConfig
  configFile: string | undefined
  layers: unknown[] | undefined
  externalEnv: EnvMap
  dotenvKeys: string[]
}

export function evaluateConfig(options: ConfigRequest & { discover: true }): Promise<string[]>
export function evaluateConfig(options: ConfigRequest): Promise<ConfigSnapshot>
/** Each evaluation owns its entire module cache and environment, including local imports. */
export function evaluateConfig(options: ConfigRequest): Promise<ConfigSnapshot | string[]> {
  const { signal, ...request } = options
  signal?.throwIfAborted()
  const source = import.meta.url.endsWith('.ts')
  const workerUrl = new URL(source ? './config-worker.ts' : './config-worker.js', import.meta.url)
  const schemaUrl = new URL(source ? './schema.ts' : './schema.js', import.meta.url).href
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { ...request, schemaUrl },
      env: { ...process.env },
      execArgv: [],
    })
    let finishing = false
    const finish = (complete: () => void): void => {
      if (finishing)
        return
      finishing = true
      signal?.removeEventListener('abort', abort)
      // Settle only after configuration-created handles have been stopped.
      void worker.terminate().then(complete, reject)
    }
    function abort(): void {
      finish(() => reject(signal!.reason))
    }
    signal?.addEventListener('abort', abort, { once: true })
    worker.once('message', (result: ConfigSnapshot | string[]) => {
      finish(() => resolve(result))
    })
    worker.once('error', error => finish(() => reject(error)))
    worker.once('exit', (code) => {
      finish(() => reject(new Error(`Configuration worker exited without a result (code ${code})`)))
    })
  })
}
