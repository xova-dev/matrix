import type { EnvMap } from '../types.js'
import type { GenerateMatrixTypesOptions } from './generate.js'
import { fork } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import process from 'node:process'
import path from 'pathe'
import { MATRIX_TYPE_CONTRACT_KEY } from '../config/env-schema.js'
import { ensureMatrixEnvPrefix } from '../runtime/public-env.js'
import { containsPath, resolveFilesystemPath } from '../utils/path.js'
import { matrixRuntimeModuleId, matrixTypeEnvKeys, matrixTypeEnvProperties, matrixTypeOutput, renderMatrixTypes } from './generate.js'

export interface TypeHost {
  name: 'vite' | 'electron-vite' | 'nuxt'
  configFile: string
  explicit?: true
}

const typeHostRules: Array<{ name: TypeHost['name'], basename: string }> = [
  { name: 'nuxt', basename: 'nuxt.config' },
  { name: 'electron-vite', basename: 'electron.vite.config' },
  { name: 'vite', basename: 'vite.config' },
]

function matchesTypeHost(filename: string, basename: string, explicit = false): boolean {
  return (explicit && filename === basename)
    || (filename.startsWith(`${basename}.`) && /^[cm]?[jt]s$/.test(filename.slice(basename.length + 1)))
}

export interface TypePreparationRequest {
  host: TypeHost
  mode: string
  command?: 'serve' | 'build'
  nodeEnv?: string
  automatic?: boolean
}

export type TypePreparationResult = { types: GenerateMatrixTypesOptions[] | null } | { error: string }

export class TypePreparationCancelled extends Error {}

/** Inspect only project-root files unless the user explicitly selects another path. */
export async function findTypeHost(cwd: string, configFile?: string, signal?: AbortSignal, configHost?: TypeHost['name']): Promise<TypeHost | undefined> {
  signal?.throwIfAborted()
  if (configHost && configFile === undefined)
    throw new Error('project.configHost requires project.configFile')
  if (configFile !== undefined) {
    const selected = resolveFilesystemPath(cwd, configFile)
    const rule = typeHostRules.find(rule => matchesTypeHost(path.basename(selected), rule.basename, true))
    if (configHost && rule && rule.name !== configHost)
      throw new Error(`project.configHost ${configHost} does not match ${rule.name} config filename: ${selected}`)
    const name = configHost ?? rule?.name
    if (!name)
      throw new Error(`Unsupported host config filename: ${selected}. Use nuxt.config, electron.vite.config or vite.config with an optional JS/TS module extension, or set project.configHost for a custom filename.`)
    const info = await stat(selected)
    signal?.throwIfAborted()
    if (!info.isFile())
      throw new Error(`Host config is not a file: ${selected}`)
    return { name, configFile: selected, explicit: true }
  }
  const entries = await readdir(cwd, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return []
    throw error
  })
  signal?.throwIfAborted()
  for (const rule of typeHostRules) {
    const candidates: string[] = []
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (matchesTypeHost(entry.name, rule.basename) && (entry.isFile() || (entry.isSymbolicLink() && (await stat(path.join(cwd, entry.name))).isFile())))
        candidates.push(entry.name)
    }
    signal?.throwIfAborted()
    if (candidates.length > 1)
      throw new Error(`Ambiguous ${rule.name} configuration in ${cwd}: ${candidates.sort().join(', ')}. Set project.configFile to select one.`)
    const file = candidates[0]
    if (file)
      return { name: rule.name, configFile: path.join(cwd, file) }
  }
  return undefined
}

/** A fresh process supplies the host's real cwd and isolates config module caches and environment. */
export async function resolveHostTypes(cwd: string, env: EnvMap, request: TypePreparationRequest, signal?: AbortSignal): Promise<GenerateMatrixTypesOptions[] | null> {
  signal?.throwIfAborted()
  const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : '../prepare-types-worker.js', import.meta.url)
  return new Promise((resolve, reject) => {
    const child = fork(workerUrl, [], {
      cwd,
      env: Object.fromEntries(Object.entries(env).filter(([key]) => key !== MATRIX_TYPE_CONTRACT_KEY).map(([key, value]) => [key, String(value)])),
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    let result: TypePreparationResult | undefined
    let failure: Error | undefined
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error): void => {
      failure ??= error
      // Configs may leave timers or watchers behind; do not wait for those to drain.
      if (request.host.name === 'nuxt' && !result) {
        // Windows terminates SIGTERM recipients without running JS cleanup.
        if (child.connected)
          child.send('cancel', error => error && child.kill('SIGKILL'))
        forceKill ??= setTimeout(() => child.kill('SIGKILL'), 1000)
      }
      else {
        child.kill('SIGKILL')
      }
    }
    const interrupt = (): void => {
      process.exitCode = 130
      finish(new TypePreparationCancelled('Type preparation interrupted'))
    }
    const terminate = (): void => {
      process.exitCode = 143
      finish(new TypePreparationCancelled('Type preparation terminated'))
    }
    const abort = (): void => {
      finish(signal?.reason instanceof TypePreparationCancelled ? signal.reason : new TypePreparationCancelled('Type preparation cancelled', { cause: signal?.reason }))
    }
    if (signal) {
      signal.addEventListener('abort', abort, { once: true })
    }
    else {
      process.once('SIGINT', interrupt)
      process.once('SIGTERM', terminate)
    }
    const timer = setTimeout(() => finish(new Error(`Host configuration timed out: ${request.host.configFile}`)), 30_000)
    child.once('message', (message: TypePreparationResult) => {
      result = message
      finish()
    })
    child.once('error', error => finish(error))
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(forceKill)
      if (signal) {
        signal.removeEventListener('abort', abort)
      }
      else {
        process.removeListener('SIGINT', interrupt)
        process.removeListener('SIGTERM', terminate)
      }
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
  const requiredKeys = new Map<string, Set<string>>()
  for (const batch of batches) {
    const seen = new Set<string>()
    for (const options of batch) {
      const output = matrixTypeOutput(options)
      const moduleId = matrixRuntimeModuleId(options.scope)
      const identity = JSON.stringify([resolveFilesystemPath(options.cwd), moduleId])
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
        !!options.strictPublicFields,
      ])
      if (signatures.has(output) && signatures.get(output) !== signature)
        throw new Error(`Conflicting Matrix type contracts at ${output}; keep scope, prefixes, and output stable across products.`)
      signatures.set(output, signature)
      const keys = new Set(Object.keys(options.env).filter(key => !options.optionalEnvKeys?.includes(key)))
      const required = requiredKeys.get(output)
      requiredKeys.set(output, required ? new Set([...required].filter(key => keys.has(key))) : keys)
      const previous = merged.get(output)
      merged.set(output, { ...options, env: matrixTypeEnvKeys(previous?.env, options.env) })
    }
  }
  const options: GenerateMatrixTypesOptions[] = [...merged.entries()].map(([output, declaration]) => ({
    ...declaration,
    optionalEnvKeys: Object.keys(declaration.env).filter(key => !requiredKeys.get(output)!.has(key)).sort(),
  }))
  // ImportMetaEnv is global even when virtual MatrixConfig modules are scoped.
  // Agree on each raw key's presence across all collected scopes, without
  // widening any scope's own config fields or their parsed schema types.
  const projectRoots = [...new Set(batches.flat().map(declaration => resolveFilesystemPath(declaration.typeProjectRoot ?? declaration.cwd)))].sort((a, b) => a.length - b.length)
  // Collection expands overlapping project aliases; their declarations may
  // coexist too. Use the outermost collected owner, not the nested host cwd.
  const globalRoot = (declaration: GenerateMatrixTypesOptions): string => {
    const root = resolveFilesystemPath(declaration.typeProjectRoot ?? declaration.cwd)
    return projectRoots.find(candidate => containsPath(candidate, root))!
  }
  const globals = new Map<string, { keys: Set<string>, required: Set<string> }>()
  for (const declaration of options) {
    const project = globalRoot(declaration)
    const properties = matrixTypeEnvProperties(declaration)
    const keys = new Set(properties.map(property => property.key))
    const required = new Set(properties.filter(property => !property.optional).map(property => property.key))
    const previous = globals.get(project)
    globals.set(project, {
      keys: new Set([...previous?.keys ?? [], ...keys]),
      required: previous ? new Set([...previous.required].filter(key => required.has(key))) : required,
    })
  }
  for (const declaration of options) {
    const global = globals.get(globalRoot(declaration))!
    declaration.optionalImportMetaEnvKeys = [...global.keys].filter(key => !global.required.has(key)).sort()
    renderMatrixTypes(declaration)
  }
  return options
}
