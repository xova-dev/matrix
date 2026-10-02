import type { EnvMap } from '../types.js'
import type { GenerateMatrixTypesOptions } from './generate.js'
import { fork } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import process from 'node:process'
import path from 'pathe'
import { ensureMatrixEnvPrefix } from '../runtime/public-env.js'
import { matrixRuntimeModuleId, matrixTypeEnvKeys, matrixTypeOutput, renderMatrixTypes } from './generate.js'

export interface TypeHost {
  name: 'vite' | 'electron-vite'
  configFile: string
}

const typeHostRules: Array<{ name: TypeHost['name'], pattern: RegExp }> = [
  { name: 'electron-vite', pattern: /^electron\.vite\.config\.[cm]?[jt]s$/ },
  { name: 'vite', pattern: /^vite\.config\.[cm]?[jt]s$/ },
]

export interface TypePreparationRequest {
  host: TypeHost
  mode: string
}

export type TypePreparationResult = { types: GenerateMatrixTypesOptions[] | null } | { error: string }

export class TypePreparationCancelled extends Error {}

/** Inspect only project-root files unless the user explicitly selects another path. */
export async function findTypeHost(cwd: string, configFile?: string): Promise<TypeHost | undefined> {
  if (configFile !== undefined) {
    const selected = path.resolve(cwd, configFile)
    const rule = typeHostRules.find(rule => rule.pattern.test(path.basename(selected)))
    if (!rule)
      throw new Error(`Unsupported host config filename: ${selected}. Use electron.vite.config.* or vite.config.*.`)
    if (!(await stat(selected)).isFile())
      throw new Error(`Host config is not a file: ${selected}`)
    return { name: rule.name, configFile: selected }
  }
  const entries = await readdir(cwd, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return []
    throw error
  })
  for (const rule of typeHostRules) {
    const candidates: string[] = []
    for (const entry of entries) {
      if (rule.pattern.test(entry.name) && (entry.isFile() || (entry.isSymbolicLink() && (await stat(path.join(cwd, entry.name))).isFile())))
        candidates.push(entry.name)
    }
    if (candidates.length > 1)
      throw new Error(`Ambiguous ${rule.name} configuration in ${cwd}: ${candidates.sort().join(', ')}. Set project.configFile to select one.`)
    const file = candidates[0]
    if (file)
      return { name: rule.name, configFile: path.join(cwd, file) }
  }
  return undefined
}

/** A fresh process supplies the host's real cwd and isolates config module caches and environment. */
export async function resolveHostTypes(cwd: string, env: EnvMap, request: TypePreparationRequest): Promise<GenerateMatrixTypesOptions[] | null> {
  const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : '../prepare-types-worker.js', import.meta.url)
  return new Promise((resolve, reject) => {
    const child = fork(workerUrl, [], {
      cwd,
      env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])),
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    let result: TypePreparationResult | undefined
    let failure: Error | undefined
    const finish = (error?: Error): void => {
      failure ??= error
      // Configs may leave timers or watchers behind; do not wait for those to drain.
      child.kill('SIGKILL')
    }
    const interrupt = (): void => {
      process.exitCode = 130
      finish(new TypePreparationCancelled('Type preparation interrupted'))
    }
    const terminate = (): void => {
      process.exitCode = 143
      finish(new TypePreparationCancelled('Type preparation terminated'))
    }
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    const timer = setTimeout(() => finish(new Error(`Host configuration timed out: ${request.host.configFile}`)), 30_000)
    child.once('message', (message: TypePreparationResult) => {
      result = message
      finish()
    })
    child.once('error', error => finish(error))
    child.once('close', (code) => {
      clearTimeout(timer)
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
      if (failure)
        reject(failure)
      else if (!result)
        reject(new Error(`Host configuration exited without type information (code ${code}): ${request.host.configFile}`))
      else if ('error' in result)
        reject(new Error(`Unable to prepare ${request.host.configFile}: ${result.error}`))
      else
        resolve(result.types)
    })
    child.send(request, error => error && finish(error))
  })
}

/** Reject incompatible contracts instead of letting the last product or scope win. */
export function mergePreparedTypes(batches: GenerateMatrixTypesOptions[][]): GenerateMatrixTypesOptions[] {
  const merged = new Map<string, GenerateMatrixTypesOptions>()
  const signatures = new Map<string, string>()
  const moduleOutputs = new Map<string, string>()
  for (const batch of batches) {
    const seen = new Set<string>()
    for (const options of batch) {
      const output = matrixTypeOutput(options)
      const moduleId = matrixRuntimeModuleId(options.scope)
      const identity = JSON.stringify([path.resolve(options.cwd), moduleId])
      if (seen.has(identity))
        throw new Error(`Duplicate Matrix scope ${moduleId} in ${options.cwd}; give each build context a distinct scope.`)
      seen.add(identity)
      const previousOutput = moduleOutputs.get(identity)
      if (previousOutput && previousOutput !== output)
        throw new Error(`Matrix type output changes between products for ${moduleId} in ${options.cwd}`)
      moduleOutputs.set(identity, output)
      const signature = JSON.stringify([
        identity,
        ensureMatrixEnvPrefix(options.envPrefix),
        Object.entries(options.envSchema ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ])
      if (signatures.has(output) && signatures.get(output) !== signature)
        throw new Error(`Conflicting Matrix type contracts at ${output}; keep scope, prefixes, and output stable across products.`)
      signatures.set(output, signature)
      const previous = merged.get(output)
      merged.set(output, { ...options, env: matrixTypeEnvKeys(previous?.env, options.env) })
    }
  }
  const options = [...merged.values()]
  for (const declaration of options)
    renderMatrixTypes(declaration)
  return options
}
