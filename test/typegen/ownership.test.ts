import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build as bundle } from 'esbuild'
import path from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli/index.js'

const previousCwd = process.cwd()
const directories: string[] = []
const plugin = fileURLToPath(new URL('../../src/unplugin/vite.ts', import.meta.url))

afterEach(async () => {
  process.chdir(previousCwd)
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-ownership-'))
  directories.push(cwd)
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(cwd, 'node_modules'), 'junction')
  await writeFile(path.join(cwd, 'package.json'), '{"type":"module"}')
  await mkdir(path.join(cwd, 'app'))
  process.chdir(cwd)
  return cwd
}

describe('prepared declaration ownership', { timeout: 20_000 }, () => {
  it('keeps a non-Vite ancestor build independent from its nested Vite project', async () => {
    const cwd = await workspace()
    await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default {
      projects: {
        legacy: { targets: { build: 'node build.mjs' } },
        web: { root: 'app', targets: { build: 'node unused.mjs' } },
      },
      products: {
        alpha: { env: { VITE_ALPHA: 'alpha' }, variants: { legacy: 'legacy' } },
        beta: { env: { VITE_BETA: 'beta' }, variants: { web: 'web' } },
      },
    }`)
    await bundle({
      entryPoints: [fileURLToPath(new URL('../../src/unplugin/rollup.ts', import.meta.url))],
      outfile: path.join(cwd, 'matrix-rollup.mjs'),
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
    })
    await writeFile(path.join(cwd, 'entry.mjs'), 'import { matrix } from "virtual:matrix/runtime"; export const config = matrix.config;')
    await writeFile(path.join(cwd, 'build.mjs'), `
      import { rollup } from 'rollup';
      import matrix from './matrix-rollup.mjs';
      const result = await rollup({ input: 'entry.mjs', plugins: [matrix({ types: true })] });
      await result.write({ file: 'built.mjs', format: 'es' });
      await result.close();
    `)
    await writeFile(path.join(cwd, 'app/vite.config.mjs'), `
      import { writeFileSync } from 'node:fs';
      import matrix from ${JSON.stringify(plugin)};
      writeFileSync('neighbor-evaluated', 'yes');
      export default { plugins: [matrix({ types: true })] };
    `)
    await runCli(['build', 'alpha'])
    const standalone = await readFile(path.join(cwd, '.matrix/types/matrix-runtime.d.ts'), 'utf8')
    expect(standalone).toContain('readonly alpha: string')
    expect(standalone).not.toContain('readonly beta')
    expect(await readFile(path.join(cwd, 'built.mjs'), 'utf8')).toContain('alpha')
    await expect(access(path.join(cwd, 'app/neighbor-evaluated'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(path.join(cwd, 'app/.matrix'))).rejects.toMatchObject({ code: 'ENOENT' })
    // Explicit preparation still discovers the entire overlapping ownership group.
    await runCli(['prepare', 'alpha'])
    expect(await readFile(path.join(cwd, 'app/.matrix/types/matrix-runtime.d.ts'), 'utf8')).toContain('readonly beta: string')
  })

  it('rejects converging external roots without overwriting and accepts aligned roots with external config files', async () => {
    const cwd = await workspace()
    const app = path.join(cwd, 'app')
    await writeFile(path.join(app, 'entry.mjs'), 'import { matrix } from "virtual:matrix/runtime"; export const config = matrix.config;')
    await writeFile(path.join(app, 'build.mjs'), 'import { build } from "vite"; await build({ configFile: "../configs/" + process.env.MATRIX_PROJECT + "/vite.config.mjs" });')
    for (const name of ['a', 'b']) {
      await mkdir(path.join(cwd, 'configs', name), { recursive: true })
      await writeFile(path.join(cwd, 'configs', name, 'vite.config.mjs'), `
        import matrix from ${JSON.stringify(plugin)};
        export default {
          root: ${JSON.stringify(app)}, envPrefix: 'APP_', plugins: [matrix({ types: true })], logLevel: 'silent',
          build: { write: false, lib: { entry: ${JSON.stringify(path.join(app, 'entry.mjs'))}, formats: ['es'] } },
        };
      `)
    }
    const configure = async (aligned: boolean, overlapping = false): Promise<void> => {
      await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default ${JSON.stringify({
        projects: Object.fromEntries(['a', 'b'].map(name => [name, {
          root: aligned ? (overlapping && name === 'b' ? '.' : 'app') : `configs/${name}`,
          ...(aligned ? { configFile: `${overlapping && name === 'b' ? '' : '../'}configs/${name}/vite.config.mjs` } : {}),
          targets: { build: 'node build.mjs' },
        }])),
        products: {
          alpha: { env: { APP_ALPHA: 'alpha' }, variants: { web: 'a' } },
          beta: { env: { APP_BETA: 'beta' }, variants: { web: 'b' } },
        },
      })}`)
    }
    await configure(true)
    await runCli(['prepare', '--env', 'production'])
    const output = path.join(app, '.matrix/types/matrix-runtime.d.ts')
    const complete = await readFile(output, 'utf8')
    expect(complete).toContain('readonly alpha?: string')
    expect(complete).toContain('readonly beta?: string')
    await configure(false)
    for (const command of [['prepare'], ['prepare', 'alpha'], ['build', 'alpha']]) {
      await expect(runCli(command)).rejects.toThrow(/ownership.*project.root.*project.configFile/)
      expect(await readFile(output, 'utf8')).toBe(complete)
    }
    await configure(true)
    await runCli(['build', 'alpha'])
    expect(await readFile(output, 'utf8')).toBe(complete)
    // An ancestor project can also own this output; selected collection includes it.
    await configure(true, true)
    await runCli(['build', 'alpha'])
    expect(await readFile(output, 'utf8')).toBe(complete)
  })

  it.each(['parent', 'symlink'])('rejects %s output escapes before writing any declaration, including missing child directories', async (escape) => {
    const cwd = await workspace()
    const app = path.join(cwd, 'app')
    await mkdir(path.join(cwd, 'outside'))
    if (escape === 'symlink')
      await symlink(path.join(cwd, 'outside'), path.join(app, 'redirect'), 'junction')
    await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default {
      projects: { web: { root: 'app', targets: { build: 'node unused.mjs' } } },
      products: { alpha: { env: { APP_ALPHA: 'alpha' }, variants: { web: 'web' } } },
    }`)
    const configure = async (output: string): Promise<void> => {
      await writeFile(path.join(app, 'vite.config.mjs'), `import matrix from ${JSON.stringify(plugin)};
        export default { envPrefix: 'APP_', plugins: [matrix({ scope: 'first', types: true }), matrix({ scope: 'second', types: { output: ${JSON.stringify(output)} } })] };
      `)
    }
    await mkdir(path.join(app, '.matrix/types'), { recursive: true })
    const first = path.join(app, '.matrix/types/matrix-runtime-first.d.ts')
    await writeFile(first, '// untouched')
    await configure(escape === 'parent' ? '../outside/missing/runtime.d.ts' : 'redirect/missing/runtime.d.ts')
    await expect(runCli(['prepare', 'alpha'])).rejects.toThrow('Cannot establish Matrix type output ownership')
    expect(await readFile(first, 'utf8')).toBe('// untouched')
    await expect(access(path.join(cwd, 'outside/missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    await configure('custom/missing/runtime.d.ts')
    await runCli(['prepare', 'alpha'])
    expect(await readFile(path.join(app, 'custom/missing/runtime.d.ts'), 'utf8')).toContain('readonly alpha: string')
  })
})
