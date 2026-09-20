import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { archiveDirectory } from '../src/archive.js'

describe('archiveDirectory', () => {
  it('fails when the source directory does not exist', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-archive-'))
    const destination = path.join(cwd, 'artifact.zip')
    const source = path.join(cwd, 'missing')

    await expect(archiveDirectory(source, destination, 'zip'))
      .rejects
      .toThrow(`Archive source directory does not exist: ${source}`)
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not replace an existing archive when the source is missing', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-archive-'))
    const destination = path.join(cwd, 'artifact.zip')
    await fs.writeFile(destination, 'previous archive')

    await expect(archiveDirectory(path.join(cwd, 'missing'), destination, 'zip')).rejects.toThrow()
    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('previous archive')
  })

  it('writes a non-empty archive for a directory', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-archive-'))
    const source = path.join(cwd, 'dist')
    const destination = path.join(cwd, 'artifacts', 'artifact.zip')
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, 'index.html'), 'matrix')

    await archiveDirectory(source, destination, 'zip')

    const archiveStats = await fs.stat(destination)
    expect(archiveStats.isFile()).toBe(true)
    expect(archiveStats.size).toBeGreaterThan(0)
    await expect(fs.readdir(path.dirname(destination))).resolves.toEqual(['artifact.zip'])
  })
})
