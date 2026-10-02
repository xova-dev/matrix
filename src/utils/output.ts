// Cleanup must preserve native filesystem semantics, including Windows casing.
import path from 'node:path'

/** Shared by static preflight and the executor; no filesystem mutations. */
export function assertSafeOutputDirectory(projectRoot: string, outputDir: string): void {
  const outputPath = path.resolve(outputDir)
  const projectPath = path.resolve(projectRoot)
  // Namespace aliases cannot be compared safely with ordinary drive/UNC paths.
  if (path.sep === '\\' && [outputPath, projectPath].some(value => /^\\\\[?.]\\/.test(value)))
    throw new Error('Refusing to clean an unsafe output directory: Windows namespace paths are unsupported')
  // Roots on other drives or UNC shares are not ancestors of this project.
  if (outputPath === path.parse(outputPath).root)
    throw new Error('Refusing to clean an unsafe output directory: filesystem root')
  const relative = path.relative(outputPath, projectPath)
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)))
    throw new Error('Refusing to clean an unsafe output directory: project root or ancestor')
}
