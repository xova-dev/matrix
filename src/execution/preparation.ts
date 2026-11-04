import type { loadMatrixConfig } from '../config/index.js'
import type { PreparedTypeContract } from '../typegen/coordination.js'
import type { TypeBatch } from '../typegen/project.js'
import type { ExecutionPlan, ExecutionTask, ProjectPreparation } from '../types.js'
import type { ExecutionSession } from './session.js'
import { MATRIX_DEFAULTS } from '../config/defaults.js'
import { MATRIX_ENV_SCHEMA_KEY, readEnvSchema, serializeEnvSchema } from '../config/env-schema.js'
import { MATRIX_TYPE_CONTRACT_KEY, preparedTypeDeclaration } from '../typegen/coordination.js'
import { matrixTypeEnvKeys } from '../typegen/generate.js'
import { findTypeHost, resolveHostTypes } from '../typegen/prepare.js'
import { generateProjectTypes, ProjectTypePreparationError } from '../typegen/project.js'
import { containsPath, resolveExistingPath, resolveFilesystemPath, resolveFuturePath } from '../utils/path.js'
import { projectPreparation } from './plan.js'
import { ExecutionFailure } from './report.js'

type LoadedConfig = Awaited<ReturnType<typeof loadMatrixConfig>>

export interface ExecutionPreparation {
  cwd: string
  prepare: (task: ExecutionTask | undefined, run: (preparation: ProjectPreparation) => Promise<void>, signal: AbortSignal, session: ExecutionSession) => Promise<void>
}

/** Context activation and host/type collection; execution owns process and resource lifetime. */
export function createPreparation(loaded: LoadedConfig, plan: ExecutionPlan, productNames?: string[], onOutput?: (output: string) => void): ExecutionPreparation {
  const planInput = { ...loaded, productNames: productNames ?? [] }
  const overlap = (left: string, right: string): boolean => containsPath(left, right) || containsPath(right, left)

  return {
    cwd: loaded.cwd,
    async prepare(task, run, signal, session) {
      const automatic = task !== undefined
      const selected = new Set(task
        ? [task.project]
        : (productNames ?? []).flatMap(name => Object.values(loaded.products[name]!.variants).map(variant => variant.project)))
      // Both entry points derive collection from the selected type owners.
      // Native preparation still owns its inputs, but owns no type outputs.
      const affected = new Set([...selected].filter(name =>
        loaded.projects[name]!.typegen !== false && (!task || task.target === 'dev' || task.target === 'build')))
      const roots = new Map<string, string>()
      for (const [name, project] of Object.entries(loaded.projects)) {
        if (selected.has(name))
          roots.set(name, await resolveFuturePath(resolveFilesystemPath(loaded.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot)))
      }

      const activate = async (preparation: ProjectPreparation | undefined): Promise<void> => {
        signal.throwIfAborted()
        if (!preparation)
          return
        await run(preparation)
        signal.throwIfAborted()
      }
      const selectedPreparation = task ? plan.preparations?.find(step => step.beforeTask === task.id) : undefined
      if (task && !affected.size) {
        await activate(selectedPreparation)
      }
      else {
        // Discovery must follow input preparation, including generated host configs.
        // Only expand a selected automatic owner if it really has a supported host.
        if (task) {
          await activate(selectedPreparation)
          const project = loaded.projects[task.project]!
          if (!await findTypeHost(resolveFilesystemPath(loaded.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot), project.configFile, signal, project.configHost)) {
            return
          }
        }
        // Unrelated roots are relevant only once host collection is required.
        if (affected.size) {
          for (const [name, project] of Object.entries(loaded.projects)) {
            if (project.typegen !== false && !roots.has(name))
              roots.set(name, await resolveFuturePath(resolveFilesystemPath(loaded.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot)))
          }
        }
        let expanded = true
        while (expanded) {
          expanded = false
          for (const [name, root] of roots) {
            if (loaded.projects[name]!.typegen === false || affected.has(name))
              continue
            if ([...affected].some(owner => overlap(roots.get(owner)!, root))) {
              affected.add(name)
              expanded = true
            }
          }
        }
        // Native projects still have a preparation lifecycle, but never join type ownership.
        const visited = new Set([...affected, ...(!task ? selected : [])])
        const batches: TypeBatch[] = []
        const contract: PreparedTypeContract = { strict: false, declarations: [] }
        const serializedSchema = serializeEnvSchema(loaded.config.envSchema)
        const envSchema = readEnvSchema({ [MATRIX_ENV_SCHEMA_KEY]: serializedSchema })
        for (const projectName of visited) {
          const project = loaded.projects[projectName]!
          const root = roots.get(projectName)!
          let expectedScopes: string | undefined
          for (const product of Object.values(loaded.products)) {
            // Explicit native preparation stays within the selected products.
            if (project.typegen === false && !productNames?.includes(product.key))
              continue
            for (const variant of Object.values(product.variants).filter(variant => variant.project === projectName)) {
              for (const targetName of ['dev', 'build'] as const) {
                const id = `${product.key}:${variant.id}:${targetName}`
                try {
                  signal.throwIfAborted()
                  const context = plan.contexts?.[id]
                  if (!context)
                    throw new Error(`Missing planned execution context: ${id}`)
                  if ('error' in context)
                    throw context.error
                  const env = context.env
                  // Explicit prepare always establishes its inputs. A target opt-out only
                  // applies to that target context during automatic collection/execution.
                  if (!automatic || variant.targets[targetName]?.prepare !== false)
                    await activate(projectPreparation(planInput, projectName, { id, env }))
                  if (project.typegen === false)
                    continue
                  const host = await findTypeHost(resolveFilesystemPath(loaded.cwd, project.root ?? MATRIX_DEFAULTS.projectRoot), project.configFile, signal, project.configHost)
                  const generic = [{ cwd: root, env: matrixTypeEnvKeys(env), envSchema }]
                  let declarations: TypeBatch['declarations'] = generic
                  let publish = !automatic
                  if (host) {
                    contract.strict = true
                    host.configFile = await resolveExistingPath(host.configFile)
                    const resolved = await resolveHostTypes(await resolveExistingPath(root), { ...env, [MATRIX_ENV_SCHEMA_KEY]: serializedSchema }, {
                      host,
                      mode: loaded.envName,
                      command: targetName === 'dev' ? 'serve' : 'build',
                      nodeEnv: String(env.NODE_ENV),
                      automatic,
                    }, signal, session)
                    signal.throwIfAborted()
                    const scopes = JSON.stringify(resolved?.map(type => [type.cwd, type.scope ?? '']).sort() ?? null)
                    if (expectedScopes !== undefined && scopes !== expectedScopes)
                      throw new Error(`Matrix scopes change between products, variants, or host contexts in ${root}; keep the type contract stable.`)
                    expectedScopes = scopes
                    declarations = resolved ?? generic
                    publish ||= resolved !== null
                  }
                  batches.push({ project: projectName, root, task: id, declarations, publish })
                }
                catch (error) {
                  signal.throwIfAborted()
                  if (error instanceof ExecutionFailure)
                    throw error
                  throw new ProjectTypePreparationError(error, projectName, id)
                }
              }
            }
          }
        }
        if (batches.length) {
          await session.use('types', batches.map(batch => ({ path: batch.root, access: 'write' })), () => generateProjectTypes(batches, {
            signal,
            ...(onOutput ? { onOutput } : {}),
            onDeclaration: declaration => contract.declarations.push(preparedTypeDeclaration(declaration)),
          }), signal)
        }
        if (task) {
          // Collection may have overwritten inputs with a different product or host mode.
          await activate(selectedPreparation)
          task.env[MATRIX_TYPE_CONTRACT_KEY] = JSON.stringify(contract)
        }
      }
    },
  }
}
