import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import archiver from 'archiver'
import consola from 'consola'

/** Archives a directory as a zip or gzip-compressed tar file. */
export async function archiveDirectory(sourceDir: string, destination: string, format: 'zip' | 'tar.gz'): Promise<void> {
  try {
    await stat(sourceDir)
  }
  catch {
    consola.warn(`Archive source does not exist, skipped: ${sourceDir}`)
    return
  }
  const relativeDestination = path.relative(path.resolve(sourceDir), path.resolve(destination))
  if (!relativeDestination || (!relativeDestination.startsWith('..') && !path.isAbsolute(relativeDestination))) {
    throw new Error(`Archive destination must be outside source directory: ${destination}`)
  }
  await mkdir(path.dirname(destination), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destination)
    const archive = archiver(
      format === 'zip' ? 'zip' : 'tar',
      format === 'tar.gz' ? { gzip: true, gzipOptions: { level: 9 } } : undefined,
    )
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.directory(sourceDir, false)
    void archive.finalize()
  })
}
