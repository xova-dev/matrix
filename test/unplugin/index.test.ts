import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'pathe'
import { resolveConfig } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MatrixUnplugin } from '../../src/unplugin/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('matrix unplugin', () => {
  it('does not overwrite types from a Vitest config by default', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'matrix-vitest-types-'))
    temporaryDirectories.push(project)
    vi.stubEnv('MAIN_VITE_WINDOW_TITLE', 'Matrix')
    await resolveConfig({
      root: project,
      configFile: false,
      envFile: false,
      envPrefix: ['MAIN_VITE_', 'MATRIX_', 'NODE_'],
      plugins: [MatrixUnplugin.vite()],
      logLevel: 'silent',
    }, 'serve')

    await expect(readFile(path.join(project, '.matrix/types/matrix-runtime.d.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([true, false])('allows explicitly generating types with inline=%s', async (inline) => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'matrix-vitest-types-'))
    temporaryDirectories.push(project)
    vi.stubEnv('MAIN_VITE_WINDOW_TITLE', 'Matrix')
    await resolveConfig({
      root: project,
      configFile: false,
      envFile: false,
      envPrefix: ['MAIN_VITE_', 'MATRIX_', 'NODE_'],
      plugins: [MatrixUnplugin.vite({ types: true, inline })],
      logLevel: 'silent',
    }, 'serve')

    await expect(readFile(path.join(project, '.matrix/types/matrix-runtime.d.ts'), 'utf8')).resolves.toContain('MAIN_VITE_WINDOW_TITLE')
  })
})
