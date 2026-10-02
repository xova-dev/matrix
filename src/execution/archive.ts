import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { TarArchive, ZipArchive } from 'archiver'

/** Archives a directory as a zip or gzip-compressed tar file. */
export async function archiveDirectory(sourceDir: string, destination: string, format: 'zip' | 'tar.gz'): Promise<void> {
  let sourceStats
  try {
    sourceStats = await stat(sourceDir)
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new Error(`Archive source directory does not exist: ${sourceDir}`, { cause: error })
    throw error
  }
  if (!sourceStats.isDirectory())
    throw new Error(`Archive source must be a directory: ${sourceDir}`)

  const relativeDestination = path.relative(path.resolve(sourceDir), path.resolve(destination))
  if (!relativeDestination || (!relativeDestination.startsWith('..') && !path.isAbsolute(relativeDestination)))
    throw new Error(`Archive destination must be outside source directory: ${destination}`)

  const destinationDirectory = path.dirname(destination)
  const temporaryDestination = path.join(destinationDirectory, `.${path.basename(destination)}.${randomUUID()}.tmp`)
  await mkdir(destinationDirectory, { recursive: true })

  let piping: Promise<void> | undefined
  try {
    const output = createWriteStream(temporaryDestination)
    const archive = format === 'zip'
      ? new ZipArchive()
      : new TarArchive({ gzip: true, gzipOptions: { level: 9 } })
    piping = pipeline(archive, output)
    archive.directory(sourceDir, false)
    await archive.finalize()
    await piping
    await rename(temporaryDestination, destination)
  }
  finally {
    await piping?.catch(() => undefined)
    await unlink(temporaryDestination).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    })
  }
}
