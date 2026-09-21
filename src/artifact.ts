import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { archiveDirectory } from './archive.js'

export interface MaterializeArtifactOptions {
  sourceDir: string
  artifactsRoot: string
  product: string
  environment: string
  variant: string
  projectRoot: string
  mode: 'move' | 'archive' | 'both'
  format: 'zip' | 'tar.gz'
  retention: number
  now?: Date
}

function archiveExtension(format: 'zip' | 'tar.gz'): string {
  return format === 'zip' ? 'zip' : 'tar.gz'
}

function timestamp(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${String(value.getFullYear()) + pad(value.getMonth() + 1) + pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`
}

async function readPackageVersion(projectRoot: string): Promise<string> {
  const packagePath = path.join(projectRoot, 'package.json')
  let packageJson: unknown
  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  }
  catch (error) {
    throw new Error(`Unable to read package version from ${packagePath}`, { cause: error })
  }
  if (!packageJson || typeof packageJson !== 'object' || typeof (packageJson as { version?: unknown }).version !== 'string' || !(packageJson as { version: string }).version.trim())
    throw new Error(`Package version is required for artifact output: ${packagePath}`)
  return (packageJson as { version: string }).version.trim()
}

async function ensureDirectory(sourceDir: string): Promise<void> {
  const sourceStats = await stat(sourceDir).catch((error: unknown) => {
    throw new Error(`Artifact source directory does not exist: ${sourceDir}`, { cause: error })
  })
  if (!sourceStats.isDirectory())
    throw new Error(`Artifact source must be a directory: ${sourceDir}`)
}

async function ensureAvailable(target: string): Promise<void> {
  try {
    await stat(target)
    throw new Error(`Artifact destination already exists: ${target}`)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
  }
}

function timestampFromName(name: string): string | undefined {
  return name.match(/(\d{8}-\d{6})(?:\.(?:zip|tar\.gz))?$/)?.[1]
}

function isPackageVersion(value: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i.test(value)
}

function isArtifactForVariant(name: string, variant: string): boolean {
  const stem = name.replace(/\.(?:zip|tar\.gz)$/, '')
  const timestamp = timestampFromName(name)
  if (!timestamp)
    return false
  const prefix = stem.slice(0, -(timestamp.length + 1))
  if (!prefix.startsWith(`${variant}-`))
    return false
  return isPackageVersion(prefix.slice(variant.length + 1))
}

async function pruneArtifacts(directory: string, variant: string, keep: number): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  const candidates = entries
    .filter(entry => isArtifactForVariant(entry.name, variant) && (entry.isDirectory() || entry.name.endsWith('.zip') || entry.name.endsWith('.tar.gz')))
    .map(async entry => ({
      name: entry.name,
      timestamp: timestampFromName(entry.name) ?? '',
      modifiedAt: (await stat(path.join(directory, entry.name))).mtimeMs,
    }))
  const sorted = (await Promise.all(candidates)).sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.modifiedAt - left.modifiedAt)
  for (const entry of sorted.slice(Math.max(keep, 0)))
    await rm(path.join(directory, entry.name), { recursive: true, force: true })
}

export async function materializeArtifact(options: MaterializeArtifactOptions): Promise<string> {
  await ensureDirectory(options.sourceDir)
  const version = await readPackageVersion(options.projectRoot)
  const now = options.now ?? new Date()
  const stem = `${options.variant}-${version}-${timestamp(now)}`
  const artifactDirectory = path.join(options.artifactsRoot, options.product, options.environment)
  const archivePath = path.join(artifactDirectory, `${stem}.${archiveExtension(options.format)}`)
  const movedPath = path.join(artifactDirectory, stem)
  await mkdir(artifactDirectory, { recursive: true })

  if (options.mode === 'archive') {
    await ensureAvailable(archivePath)
    await archiveDirectory(options.sourceDir, archivePath, options.format)
  }
  else if (options.mode === 'move') {
    await ensureAvailable(movedPath)
    await rename(options.sourceDir, movedPath)
  }
  else {
    await ensureAvailable(movedPath)
    const temporaryArchive = path.join(artifactDirectory, `.${stem}.${randomUUID()}.${archiveExtension(options.format)}`)
    try {
      await archiveDirectory(options.sourceDir, temporaryArchive, options.format)
      await rename(options.sourceDir, movedPath)
      await rename(temporaryArchive, path.join(movedPath, `${stem}.${archiveExtension(options.format)}`))
    }
    finally {
      await rm(temporaryArchive, { force: true })
    }
  }

  await pruneArtifacts(artifactDirectory, options.variant, options.retention)
  return options.mode === 'archive' ? archivePath : movedPath
}
