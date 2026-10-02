import path from 'node:path'

/** Shared by static preflight and the executor; no filesystem mutations. */
export function assertSafeOutputDirectory(projectRoot: string, outputDir: string): void {
  const relative = path.relative(path.resolve(outputDir), path.resolve(projectRoot))
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)))
    throw new Error('Refusing to clean an unsafe output directory: project root or ancestor')
}
