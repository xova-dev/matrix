import type { GenerateMatrixTypesOptions } from './generate.js'
import { containsPath, resolveFuturePath } from '../utils/path.js'
import { generateMatrixTypes, matrixTypeOutput } from './generate.js'
import { mergePreparedTypes } from './prepare.js'

export interface TypeBatch {
  project: string
  root: string
  task: string
  declarations: GenerateMatrixTypesOptions[]
  publish: boolean
}

export class ProjectTypePreparationError extends Error {
  constructor(error: unknown, readonly project: string, readonly task?: string) {
    super(error instanceof Error ? error.message : 'Unable to generate project types', { cause: error })
  }
}

/** Publish a complete collection. Context selection and host execution belong to the executor. */
export async function generateProjectTypes(batches: TypeBatch[], options: {
  signal?: AbortSignal
  onOutput?: (output: string) => void
  onDeclaration?: (declaration: GenerateMatrixTypesOptions) => void
} = {}): Promise<string[]> {
  const outputsToWrite = new Set<string>()
  const sources = new Map<string, { projects: Set<string>, tasks: Set<string> }>()
  for (const batch of batches) {
    for (const declaration of batch.declarations) {
      options.signal?.throwIfAborted()
      const output = await resolveFuturePath(matrixTypeOutput(declaration))
      if (!containsPath(batch.root, declaration.cwd) || !containsPath(batch.root, output))
        throw new ProjectTypePreparationError(new Error(`Cannot establish Matrix type output ownership for project ${batch.project}: host root ${declaration.cwd} and output ${output} must stay within project.root ${batch.root}. Set project.root to the actual shared host project directory; use project.configFile to reference a configuration stored elsewhere.`), batch.project, batch.task)
      declaration.typeProjectRoot = batch.root
      declaration.output = output
      if (batch.publish)
        outputsToWrite.add(output)
      const source = sources.get(output) ?? { projects: new Set<string>(), tasks: new Set<string>() }
      source.projects.add(batch.project)
      source.tasks.add(batch.task)
      sources.set(output, source)
    }
  }
  const outputs: string[] = []
  for (const declaration of mergePreparedTypes(batches.map(batch => batch.declarations))) {
    options.signal?.throwIfAborted()
    if (!outputsToWrite.has(matrixTypeOutput(declaration)))
      continue
    const source = sources.get(matrixTypeOutput(declaration))!
    try {
      const output = await generateMatrixTypes(declaration, options.signal)
      outputs.push(output)
      options.onDeclaration?.(declaration)
      options.onOutput?.(output)
    }
    catch (error) {
      options.signal?.throwIfAborted()
      throw new ProjectTypePreparationError(error, [...source.projects].join(', '), [...source.tasks].join(', '))
    }
  }
  return outputs
}
