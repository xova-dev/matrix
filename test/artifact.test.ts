import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { materializeArtifact } from '../src/artifact.js'

async function createProject(): Promise<{ root: string, output: string, artifacts: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-artifact-'))
  const output = path.join(root, 'dist')
  const artifacts = path.join(root, 'artifacts')
  await fs.mkdir(output, { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'artifact-test', version: '0.1.8' }))
  await fs.writeFile(path.join(output, 'index.html'), 'matrix')
  return { root, output, artifacts }
}

describe('materializeArtifact', () => {
  it('archives with a flat variant-version-datetime name and keeps the source', async () => {
    const project = await createProject()
    const result = await materializeArtifact({
      sourceDir: project.output,
      artifactsRoot: project.artifacts,
      product: 'english-speaking',
      environment: 'staging',
      variant: 'web',
      projectRoot: project.root,
      mode: 'archive',
      format: 'zip',
      retention: 5,
      now: new Date(2026, 8, 21, 15, 30, 12),
    })

    expect(result).toBe(path.join(project.artifacts, 'english-speaking', 'staging', 'web-0.1.8-20260921-153012.zip'))
    await expect(fs.stat(result)).resolves.toMatchObject({ isFile: expect.any(Function) })
    await expect(fs.readFile(path.join(project.output, 'index.html'), 'utf8')).resolves.toBe('matrix')
  })

  it('moves the complete output directory and retains its structure', async () => {
    const project = await createProject()
    await fs.mkdir(path.join(project.output, 'win-unpacked'))
    await fs.writeFile(path.join(project.output, 'win-unpacked', 'app.exe'), 'binary')

    const result = await materializeArtifact({
      sourceDir: project.output,
      artifactsRoot: project.artifacts,
      product: 'english-speaking',
      environment: 'staging',
      variant: 'desktop',
      projectRoot: project.root,
      mode: 'move',
      format: 'zip',
      retention: 5,
      now: new Date(2026, 8, 21, 15, 30, 12),
    })

    await expect(fs.readFile(path.join(result, 'win-unpacked', 'app.exe'), 'utf8')).resolves.toBe('binary')
    await expect(fs.stat(project.output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('archives and moves the source as one artifact set', async () => {
    const project = await createProject()
    const result = await materializeArtifact({
      sourceDir: project.output,
      artifactsRoot: project.artifacts,
      product: 'english-speaking',
      environment: 'staging',
      variant: 'desktop',
      projectRoot: project.root,
      mode: 'both',
      format: 'zip',
      retention: 5,
      now: new Date(2026, 8, 21, 15, 30, 12),
    })

    await expect(fs.readFile(path.join(result, 'index.html'), 'utf8')).resolves.toBe('matrix')
    await expect(fs.stat(path.join(result, 'desktop-0.1.8-20260921-153012.zip'))).resolves.toMatchObject({ isFile: expect.any(Function) })
    await expect(fs.stat(project.output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the newest five ArtifactSets for a variant', async () => {
    const project = await createProject()
    for (let index = 0; index < 6; index++) {
      await fs.mkdir(project.output, { recursive: true })
      await fs.writeFile(path.join(project.output, 'index.html'), String(index))
      await materializeArtifact({
        sourceDir: project.output,
        artifactsRoot: project.artifacts,
        product: 'english-speaking',
        environment: 'staging',
        variant: 'web',
        projectRoot: project.root,
        mode: 'archive',
        format: 'zip',
        retention: 5,
        now: new Date(2026, 8, 21, 15, 30, 12 + index),
      })
    }

    await expect(fs.readdir(path.join(project.artifacts, 'english-speaking', 'staging'))).resolves.toHaveLength(5)
  })

  it('does not count variants that only share a name prefix', async () => {
    const project = await createProject()
    const materialize = async (variant: string, second: number, retention: number): Promise<void> => {
      await fs.mkdir(project.output, { recursive: true })
      await fs.writeFile(path.join(project.output, 'index.html'), variant)
      await materializeArtifact({
        sourceDir: project.output,
        artifactsRoot: project.artifacts,
        product: 'english-speaking',
        environment: 'staging',
        variant,
        projectRoot: project.root,
        mode: 'archive',
        format: 'zip',
        retention,
        now: new Date(2026, 8, 21, 15, 30, second),
      })
    }

    for (let second = 12; second < 18; second++)
      await materialize('web-admin', second, 10)
    for (let second = 18; second < 24; second++)
      await materialize('web', second, 5)

    const entries = await fs.readdir(path.join(project.artifacts, 'english-speaking', 'staging'))
    expect(entries.filter(entry => entry.startsWith('web-admin-'))).toHaveLength(6)
    expect(entries.filter(entry => /^web-\d/.test(entry))).toHaveLength(5)
  })
})
