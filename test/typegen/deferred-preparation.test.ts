import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli/index.js'

const originalCwd = process.cwd()
const directories: string[] = []

afterEach(async () => {
  process.chdir(originalCwd)
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('deferred preparation contracts', () => {
  it.each([
    { initialHost: false, sharedOwner: false },
    { initialHost: true, sharedOwner: false },
    { initialHost: true, sharedOwner: true },
  ])('refreshes contracts after preparation (initial host: $initialHost, shared owner: $sharedOwner)', async ({ initialHost, sharedOwner }) => {
    const cwd = path.normalize(await realpath(await mkdtemp(path.join(os.tmpdir(), 'matrix-deferred-types-'))))
    directories.push(cwd)
    await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(cwd, 'node_modules'), 'junction')
    await writeFile(path.join(cwd, 'package.json'), '{"type":"module"}')
    await writeFile(path.join(cwd, 'matrix.config.mjs'), `export default ${JSON.stringify({
      projects: {
        web: { ...(!sharedOwner ? { prepare: 'node prepare.mjs' } : {}), targets: { build: 'node build.mjs' } },
        ...(sharedOwner ? { other: { prepare: 'node prepare.mjs', targets: { build: 'node build.mjs' } } } : {}),
      },
      products: {
        alpha: {
          env: { VITE_ALPHA: 'alpha' },
          variants: {
            early: { project: 'web', targets: { build: { command: sharedOwner ? 'node build.mjs' : 'node early.mjs', prepare: false } } },
            later: { project: sharedOwner ? 'other' : 'web', targets: { build: { dependsOn: ['early'] } } },
            last: { project: 'web', targets: { build: { dependsOn: ['later'] } } },
          },
        },
        beta: { env: { VITE_BETA: 'beta' }, variants: { web: 'web' } },
      },
    })}`)
    const plugin = fileURLToPath(new URL('../../src/unplugin/vite.ts', import.meta.url))
    const config = `
      import { appendFileSync, existsSync } from 'node:fs';
      import matrix from ${JSON.stringify(plugin)};
      appendFileSync('evaluations.jsonl', JSON.stringify({ active: !!process.env.ACTIVE_BUILD, prepared: existsSync('prepared') }) + '\\n');
      export default { plugins: [matrix({ types: true })], build: { write: false, lib: { entry: 'entry.mjs', formats: ['es'] } } };
    `
    await writeFile(path.join(cwd, 'host-template.mjs'), config)
    if (initialHost)
      await writeFile(path.join(cwd, 'vite.config.mjs'), config)
    await writeFile(path.join(cwd, 'prepare.mjs'), `
      import { copyFileSync, writeFileSync } from 'node:fs';
      copyFileSync('host-template.mjs', 'vite.config.mjs');
      writeFileSync('.env.production', 'VITE_AFTER=prepared\\n');
      writeFileSync('prepared', 'yes');
    `)
    await writeFile(path.join(cwd, 'early.mjs'), '')
    await writeFile(path.join(cwd, 'entry.mjs'), 'export const value = 1')
    await writeFile(path.join(cwd, 'build.mjs'), `process.env.ACTIVE_BUILD = 'yes'; const { build } = await import('vite'); await build();`)
    process.chdir(cwd)
    await runCli(['build', 'alpha', '--variant', 'last'])

    const declaration = await readFile(path.join(cwd, '.matrix/types/matrix-runtime.d.ts'), 'utf8')
    expect(declaration).toContain('readonly alpha?: string')
    expect(declaration).toContain('readonly beta?: string')
    expect(declaration).toContain('readonly after: string')
    const evaluations = (await readFile(path.join(cwd, 'evaluations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    // Four associated variants, two canonical contexts. One owner reuses its
    // refreshed contract; interleaved web → other → web must refresh both caches.
    expect(evaluations.filter(entry => !entry.active && entry.prepared)).toHaveLength(sharedOwner ? 16 : 8)
    expect(evaluations.filter(entry => !entry.active && !entry.prepared)).toHaveLength(initialHost ? 8 : 0)
    expect(evaluations.filter(entry => entry.active)).toHaveLength(sharedOwner ? 3 : 2)
  }, 30_000)
})
