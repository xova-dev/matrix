import type { MatrixConfig } from '../src/types.js'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/cli.js'
import { loadMatrixConfig } from '../src/config.js'
import { runExecutionPlan } from '../src/exec.js'
import { createExecutionPlan } from '../src/plan.js'
import { assertMatrixConfig } from '../src/schema.js'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-prepare-'))
  await writeFile(path.join(cwd, 'record.mjs'), [
    'import { appendFileSync, writeFileSync } from "node:fs";',
    'const event = process.argv[2];',
    'const record = event => appendFileSync("events.jsonl", JSON.stringify({',
    '  event, cwd: process.cwd(), layer: process.env.PREP_LAYER,',
    '  product: process.env.MATRIX_PRODUCT_KEY, variant: process.env.MATRIX_VARIANT,',
    '  project: process.env.MATRIX_PROJECT, environment: process.env.MATRIX_ENV_NAME,',
    '  dotenv: process.env.PREP_DOTENV,',
    '}) + String.fromCharCode(10));',
    'if (event === "wait") {',
    '  process.on("SIGTERM", () => setTimeout(() => { record("cleanup"); process.exit(0); }, 50));',
    '  setInterval(() => {}, 1000);',
    '  writeFileSync("ready", "ready");',
    '} else {',
    '  record(event);',
    '  if (event === "fail") process.exit(7);',
    '}',
  ].join(String.fromCharCode(10)))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function execution(config: MatrixConfig, productNames = ['app']) {
  await writeFile(path.join(cwd, 'matrix.config.json'), JSON.stringify(config))
  const loaded = await loadMatrixConfig({ cwd, envName: 'qa' })
  return createExecutionPlan({ ...loaded, productNames, target: 'test' })
}

async function events(): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path.join(cwd, 'events.jsonl'), 'utf8')).trim().split(String.fromCharCode(10)).map(line => JSON.parse(line))
}

function preparedProject(prepare: string | string[]): MatrixConfig {
  return {
    projects: { shared: { prepare, targets: { test: 'node record.mjs target' } } },
    products: { app: { variants: { first: 'shared' } } },
  }
}

describe('project preparation', () => {
  it('prepares dependencies and shared projects once per invocation, after skipped targets', async () => {
    await writeFile(path.join(cwd, '.env.qa'), 'PREP_DOTENV=dotenv-value')
    const plan = await execution({
      env: { PREP_LAYER: 'global' },
      projects: {
        shared: {
          prepare: ['node record.mjs prepare:first', 'node record.mjs prepare:last'],
          targets: { test: 'node record.mjs target' },
        },
        dependency: { prepare: 'node record.mjs dependency-prepare', targets: { test: 'node record.mjs dependency' } },
        unused: { prepare: 'node record.mjs unused', targets: { test: 'node record.mjs unused-target' } },
      },
      products: {
        app: {
          env: { PREP_LAYER: 'product' },
          variants: {
            skipped: { project: 'shared', targets: { test: { command: 'node record.mjs skipped', prepare: false } } },
            first: { project: 'shared', targets: { test: { command: 'node record.mjs first', dependsOn: ['dependency'] } } },
            second: { project: 'shared', targets: { test: 'node record.mjs second' } },
            dependency: 'dependency',
          },
        },
        other: { variants: { shared: { project: 'shared', targets: { test: 'node record.mjs other' } } } },
      },
    }, ['app', 'other'])
    expect(plan.preparations?.map(step => [step.project, step.beforeTask])).toEqual([
      ['dependency', 'app:dependency:test'],
      ['shared', 'app:first:test'],
    ])
    await runExecutionPlan(plan)
    const recorded = await events()
    const expected = ['skipped', 'dependency-prepare', 'dependency', 'prepare:first', 'prepare:last', 'first', 'second', 'other']
    expect(recorded.map(event => event.event)).toEqual(expected)
    expect(recorded[3]).toEqual({ event: 'prepare:first', cwd: await realpath(cwd), layer: 'global', project: 'shared', environment: 'qa', dotenv: 'dotenv-value' })
    expect(recorded[5]).toMatchObject({ layer: 'product', product: 'app', variant: 'first' })
    await runExecutionPlan(plan)
    expect((await events()).map(event => event.event)).toEqual([...expected, ...expected])
  })

  it('does not prepare a project when every selected target opts out', async () => {
    const config = preparedProject('node record.mjs prepare')
    config.projects.shared!.targets.test = { command: 'node record.mjs target', prepare: false }
    const plan = await execution(config)
    expect(plan.preparations).toBeUndefined()
    await runExecutionPlan(plan)
    expect((await events()).map(event => event.event)).toEqual(['target'])
  })

  it('cleans before preparation and preserves reusable inputs across variant artifact delivery', async () => {
    await mkdir(path.join(cwd, 'dist'))
    await writeFile(path.join(cwd, 'dist/stale.txt'), 'stale')
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
    await writeFile(path.join(cwd, 'prepare.mjs'), [
      'import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";',
      'if (existsSync("dist/stale.txt")) throw new Error("Output was not cleaned before preparation");',
      'mkdirSync(".prepared", { recursive: true });',
      'writeFileSync(".prepared/input.txt", "shared-input");',
      'writeFileSync("dist/prepared.txt", "first-target-input");',
      'appendFileSync("prepare-count", "once;");',
    ].join(String.fromCharCode(10)))
    await writeFile(path.join(cwd, 'generate.mjs'), [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      'if (existsSync("dist/stale.txt")) throw new Error("Stale output survived");',
      'if (process.env.MATRIX_VARIANT === "first" && !existsSync("dist/prepared.txt")) throw new Error("Fresh preparation output was removed");',
      'writeFileSync("dist/generated.txt", readFileSync(".prepared/input.txt", "utf8") + ":" + process.env.MATRIX_VARIANT);',
    ].join(String.fromCharCode(10)))
    await writeFile(path.join(cwd, 'build.mjs'), 'import { readFileSync, writeFileSync } from "node:fs"; writeFileSync("dist/result.txt", readFileSync("dist/generated.txt"));')
    const plan = await execution({
      projects: {
        shared: {
          prepare: 'node prepare.mjs',
          targets: { test: { command: ['node generate.mjs', 'node build.mjs'], artifacts: { mode: 'move' } } },
        },
      },
      products: { app: { variants: { first: 'shared', second: 'shared' } } },
    })
    await runExecutionPlan(plan)
    expect(await readFile(path.join(cwd, 'prepare-count'), 'utf8')).toBe('once;')
    const destination = path.join(plan.artifactsRoot, 'app', 'qa')
    const artifacts = await readdir(destination)
    const results = await Promise.all(artifacts.map(artifact => readFile(path.join(destination, artifact, 'result.txt'), 'utf8')))
    expect(results.sort()).toEqual(['shared-input:first', 'shared-input:second'])
  })

  it('stops the command sequence and targets on preparation failure', async () => {
    const plan = await execution(preparedProject(['node record.mjs fail', 'node record.mjs never']))
    await expect(runExecutionPlan(plan)).rejects.toThrow('prepare:shared exited with code 7')
    expect((await events()).map(event => event.event)).toEqual(['fail'])
  })

  it.each(['test', 'prepare'])('cancels a later preparation command during %s without continuing execution', async (command) => {
    await execution(preparedProject(['node record.mjs first', 'node record.mjs wait', 'node record.mjs never']))
    const previousCwd = process.cwd()
    const previousExitCode = process.exitCode
    process.chdir(cwd)
    const running = runCli([command, 'app', '-e', 'qa'])
    try {
      await vi.waitFor(async () => expect(await readFile(path.join(cwd, 'ready'), 'utf8')).toBe('ready'), { timeout: 2000 })
      process.emit('SIGTERM')
      await running
      expect(process.exitCode).toBe(143)
      expect((await events()).map(event => event.event)).toEqual(['first', 'cleanup'])
      await expect(readFile(path.join(cwd, '.matrix/types/matrix-runtime.d.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    finally {
      process.emit('SIGTERM')
      try {
        await running
      }
      finally {
        process.chdir(previousCwd)
        process.exitCode = previousExitCode
      }
    }
  })

  it('rejects empty commands and full target objects as project preparation', () => {
    for (const prepare of ['', ' ', [], ['node setup.mjs', ' '], { command: 'node setup.mjs', continuous: true }]) {
      expect(() => assertMatrixConfig({
        projects: { app: { prepare, targets: { test: 'node test.mjs' } } },
        products: { app: { variants: { app: 'app' } } },
      })).toThrow()
    }
  })
})
