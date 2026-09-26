import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.js'

describe('cli entry', () => {
  it('prints help without loading a workspace configuration', async () => {
    const output: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => output.push(args.join(' '))
    try {
      await runCli(['--help'])
      await runCli(['dev', 'app', '-h'])
    }
    finally {
      console.log = originalLog
    }
    expect(output[0]).toContain('matrix')
    expect(output[1]).toContain('matrix')
  })

  it('rejects invalid command options before loading a workspace configuration', async () => {
    await expect(runCli(['doctor', '--target', 'build']))
      .rejects
      .toThrow('doctor only accepts --env')
  })

  it('prepares shared projects once and generates types for the selected products', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-cli-prepare-'))
    const previousCwd = process.cwd()
    try {
      await mkdir(path.join(cwd, 'apps/web'), { recursive: true })
      await mkdir(path.join(cwd, 'apps/desktop'), { recursive: true })
      for (const project of ['web', 'desktop']) {
        await writeFile(path.join(cwd, 'apps', project, 'prepare.mjs'), 'import { appendFileSync } from "node:fs"; appendFileSync("prepared", "done;");')
      }
      await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default {
        env: { VITE_SHARED: 'shared' },
        projects: {
          web: { root: 'apps/web', prepare: 'node prepare.mjs', targets: { dev: 'vite' } },
          desktop: { root: 'apps/desktop', prepare: ['node prepare.mjs'], targets: { dev: 'vite' } },
        },
        products: {
          webApp: { env: { VITE_WEB_ONLY: 'web' }, variants: { web: 'web' } },
          secondWeb: { env: { VITE_SECOND_WEB: 'second' }, variants: { web: 'web' } },
          desktopApp: { env: { VITE_DESKTOP_ONLY: 'desktop' }, variants: { desktop: 'desktop' } },
        },
      }`)
      process.chdir(cwd)

      await runCli(['prepare'])

      const webTypes = await readFile(path.join(cwd, 'apps/web/.matrix/types/matrix-runtime.d.ts'), 'utf8')
      const desktopTypes = await readFile(path.join(cwd, 'apps/desktop/.matrix/types/matrix-runtime.d.ts'), 'utf8')
      expect(webTypes).toContain('readonly VITE_WEB_ONLY: string')
      expect(webTypes).toContain('readonly VITE_SHARED: string')
      expect(webTypes).toContain('readonly VITE_SECOND_WEB: string')
      expect(webTypes).not.toContain('readonly VITE_DESKTOP_ONLY: string')
      expect(desktopTypes).toContain('readonly VITE_DESKTOP_ONLY: string')
      expect(desktopTypes).toContain('readonly VITE_SHARED: string')
      expect(desktopTypes).not.toContain('readonly VITE_WEB_ONLY: string')
      expect(await readFile(path.join(cwd, 'apps/web/prepared'), 'utf8')).toBe('done;')
      expect(await readFile(path.join(cwd, 'apps/desktop/prepared'), 'utf8')).toBe('done;')
      await runCli(['prepare', 'desktopApp'])
      expect(await readFile(path.join(cwd, 'apps/web/prepared'), 'utf8')).toBe('done;')
      expect(await readFile(path.join(cwd, 'apps/desktop/prepared'), 'utf8')).toBe('done;done;')
    }
    finally {
      process.chdir(previousCwd)
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
