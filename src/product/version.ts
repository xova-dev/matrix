import { readFileSync } from 'node:fs'
import path from 'pathe'
import { isReleaseVersion } from '../config/schema.js'

export function validateReleaseVersion(value: unknown, source: string): string {
  if (!isReleaseVersion(value))
    throw new Error(`Invalid release version at ${source}: expected SemVer`)
  return value
}

/** Read only the selected project's fallback; versionless non-artifact tasks remain supported. */
export function readPackageVersion(projectRoot: string, required: boolean): string | undefined {
  const packagePath = path.join(projectRoot, 'package.json')
  let contents: string
  try {
    contents = readFileSync(packagePath, 'utf8')
  }
  catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    throw new Error(`Unable to read package version from ${packagePath}`)
  }
  let packageJson: unknown
  try {
    packageJson = JSON.parse(contents)
  }
  catch {
    throw new Error(`Unable to read package version from ${packagePath}`)
  }
  const version = packageJson && typeof packageJson === 'object'
    ? (packageJson as { version?: unknown }).version
    : undefined
  if (version === undefined && !required)
    return undefined
  if (version === undefined)
    throw new Error(`Package version is required for artifact output: ${packagePath}`)
  return validateReleaseVersion(typeof version === 'string' ? version.trim() : version, `${packagePath} version`)
}
