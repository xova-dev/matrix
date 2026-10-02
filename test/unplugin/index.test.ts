import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { MatrixUnplugin } from '../../src/unplugin/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('matrix unplugin', () => {
  it('does not overwrite types from a Vitest config by default', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'matrix-vitest-types-'))
    temporaryDirectories.push(project)
    const plugin = MatrixUnplugin.vite()
    const configResolved = (Array.isArray(plugin) ? plugin : [plugin]).find(plugin => plugin.configResolved)?.configResolved
    if (configResolved) {
      const handler = typeof configResolved === 'function' ? configResolved : configResolved.handler
      await handler.call({} as never, {
        root: project,
        plugins: [],
        env: { MAIN_VITE_WINDOW_TITLE: 'Matrix' },
        envPrefix: ['MAIN_VITE_', 'MATRIX_', 'NODE_'],
      } as never)
    }

    await expect(readFile(path.join(project, '.matrix/types/matrix-runtime.d.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([true, false])('allows explicitly generating types with inline=%s', async (inline) => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'matrix-vitest-types-'))
    temporaryDirectories.push(project)
    const plugin = MatrixUnplugin.vite({ types: true, inline })
    const configResolved = (Array.isArray(plugin) ? plugin : [plugin]).find(plugin => plugin.configResolved)?.configResolved
    if (configResolved) {
      const handler = typeof configResolved === 'function' ? configResolved : configResolved.handler
      await handler.call({} as never, {
        root: project,
        plugins: [],
        env: { MAIN_VITE_WINDOW_TITLE: 'Matrix' },
        envPrefix: ['MAIN_VITE_', 'MATRIX_', 'NODE_'],
      } as never)
    }

    await expect(readFile(path.join(project, '.matrix/types/matrix-runtime.d.ts'), 'utf8')).resolves.toContain('MAIN_VITE_WINDOW_TITLE')
  })
})
