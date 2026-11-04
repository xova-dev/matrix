import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'pathe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli as executeCli } from '../../src/cli/index.js'
import { createTestExecution } from '../helpers/test-execution.js'

const testExecution = createTestExecution()
const runCli = (...args: Parameters<typeof executeCli>) => testExecution.run(() => executeCli(...args))

const originalCwd = process.cwd()
const directories: string[] = []

beforeEach(ctx => testExecution.begin(ctx.signal))

afterEach(async () => {
  const owned = directories.splice(0)
  try {
    await testExecution.cleanup()
  }
  finally {
    process.chdir(originalCwd)
  }
  for (const directory of owned)
    await rm(directory, { recursive: true, force: true })
}, 60_000)

describe('deferred preparation contracts', { timeout: 120_000 }, () => {
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
    await writeFile(path.join(cwd, 'context.mjs'), `
      export const context = () => ['MATRIX_PRODUCT_KEY', 'MATRIX_VARIANT', 'MATRIX_TARGET', 'MATRIX_PROJECT'].map(key => process.env[key]);
    `)
    const config = `
      import { appendFileSync, existsSync, readFileSync } from 'node:fs';
      import { context } from './context.mjs';
      import matrix from ${JSON.stringify(plugin)};
      appendFileSync('evaluations.jsonl', JSON.stringify({
        active: !!process.env.ACTIVE_BUILD,
        context: context(),
        generated: existsSync('prepared') ? JSON.parse(readFileSync('prepared', 'utf8')) : null,
      }) + '\\n');
      export default { plugins: [matrix({ types: true })], build: { write: false, lib: { entry: 'entry.mjs', formats: ['es'] } } };
    `
    await writeFile(path.join(cwd, 'host-template.mjs'), config)
    if (initialHost)
      await writeFile(path.join(cwd, 'vite.config.mjs'), config)
    await writeFile(path.join(cwd, 'prepare.mjs'), `
      import { copyFileSync, writeFileSync } from 'node:fs';
      import { context } from './context.mjs';
      copyFileSync('host-template.mjs', 'vite.config.mjs');
      writeFileSync('.env.production', 'VITE_AFTER=prepared\\n');
      writeFileSync('prepared', JSON.stringify(context()));
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
    const contexts = [
      ['alpha', 'early', 'web'],
      ['alpha', 'later', sharedOwner ? 'other' : 'web'],
      ['alpha', 'last', 'web'],
      ['beta', 'web', 'web'],
    ].flatMap(([product, variant, project]) => ['dev', 'build'].map(target => [product, variant, target, project]))
    expect(new Set(evaluations.filter(entry => !entry.active).map(entry => JSON.stringify(entry.context))))
      .toEqual(new Set(contexts.map(context => JSON.stringify(context))))
    const preparedEvaluations = evaluations.filter(entry => sharedOwner
      ? entry.context[3] === 'other'
      : !(entry.context[1] === 'early' && entry.context[2] === 'build'))
    expect(preparedEvaluations.length).toBeGreaterThan(0)
    // Include active builds: collecting other products must restore their inputs.
    for (const entry of preparedEvaluations)
      expect(entry.generated).toEqual(entry.context)
    const active = evaluations.filter(entry => entry.active)
    expect(new Set(active.map(entry => entry.context[1]))).toEqual(new Set(sharedOwner ? ['early', 'later', 'last'] : ['later', 'last']))
  })
})
