import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import consola from 'consola'
import path from 'pathe'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli/index.js'

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

  it('rejects missing host configs instead of reporting the configuration as valid', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-cli-doctor-'))
    const previousCwd = process.cwd()
    const success = vi.spyOn(consola, 'success').mockImplementation(() => {})
    const error = vi.spyOn(consola, 'error').mockImplementation(() => {})
    try {
      await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default {
        projects: { web: { configFile: 'missing/vite.config.ts', targets: { build: 'must-not-run' } } },
        products: { alpha: { variants: { web: 'web' } } },
      }`)
      process.chdir(cwd)
      await expect(runCli(['doctor'])).rejects.toThrow('Doctor found 1 error(s).')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('projects.web.configFile'))
      expect(success).not.toHaveBeenCalled()
    }
    finally {
      success.mockRestore()
      error.mockRestore()
      process.chdir(previousCwd)
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('prepares shared projects once and generates types for the selected products', async () => {
    const messages: string[] = []
    const info = vi.spyOn(consola, 'info').mockImplementation((message) => {
      messages.push(String(message))
    })
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
        envSchema: {
          VITE_ENABLED: { type: 'boolean', default: false },
          VITE_MODE: { type: 'enum', values: ['remote', 'bundled'] },
          MAIN_VITE_SECRET: { type: 'string' },
        },
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
      expect(webTypes).toContain('readonly VITE_WEB_ONLY?: string')
      expect(webTypes).toContain('readonly VITE_SHARED: string')
      expect(webTypes).toContain('readonly VITE_SECOND_WEB?: string')
      expect(webTypes).toContain('readonly enabled: boolean')
      expect(webTypes).toContain('readonly mode: "remote" | "bundled"')
      expect(webTypes).not.toContain('MAIN_VITE_SECRET')
      expect(webTypes).not.toMatch(/readonly VITE_DESKTOP_ONLY[?:]/)
      expect(desktopTypes).toContain('readonly VITE_DESKTOP_ONLY: string')
      expect(desktopTypes).toContain('readonly VITE_SHARED: string')
      expect(desktopTypes).not.toMatch(/readonly VITE_WEB_ONLY[?:]/)
      expect(await readFile(path.join(cwd, 'apps/web/prepared'), 'utf8')).toBe('done;')
      expect(await readFile(path.join(cwd, 'apps/desktop/prepared'), 'utf8')).toBe('done;')
      const summaries = messages.filter(message => message.startsWith('Execution '))
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toContain('Execution succeeded')
      expect(summaries[0]).toContain('prepare:web: completed')
      expect(summaries[0]).toContain('prepare:desktop: completed')
      expect(summaries[0]).toContain('apps/web/.matrix/types/matrix-runtime.d.ts')
      expect(summaries[0]).toContain('apps/desktop/.matrix/types/matrix-runtime.d.ts')
      await runCli(['prepare', 'desktopApp'])
      expect(await readFile(path.join(cwd, 'apps/web/prepared'), 'utf8')).toBe('done;')
      expect(await readFile(path.join(cwd, 'apps/desktop/prepared'), 'utf8')).toBe('done;done;')
    }
    finally {
      info.mockRestore()
      process.chdir(previousCwd)
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
