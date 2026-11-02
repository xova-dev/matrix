import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const read = name => parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
const expression = value => `$` + `{{ ${value} }}`
const publish = read('publish')
const recover = read('docs-recover')
const checks = read('checks')
const ci = read('ci')
const config = JSON.parse(readFileSync(new URL('../../.github/xova.json', import.meta.url), 'utf8'))

it('uses one pinned toolkit revision and validates supplied local contracts', async () => {
  if (process.env.XOVA_ACTIONS_ROOT) {
    const root = resolve(process.env.XOVA_ACTIONS_ROOT)
    const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    expect(revision, 'Local toolkit must match the pinned workflow revision').toBe(checks.jobs.quality.uses.split('@')[1])
    for (const args of [['diff', '--quiet', '--no-ext-diff'], ['diff', '--cached', '--quiet', '--no-ext-diff']])
      execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  }
  const references = []
  for (const file of readdirSync(new URL('../../.github/workflows/', import.meta.url))) {
    for (const job of Object.values(read(file.replace('.yml', '')).jobs)) {
      for (const call of [job, ...(job.steps || [])]) {
        if (!call.uses?.startsWith('xova-dev/actions/'))
          continue
        const [target, revision] = call.uses.split('@')
        references.push(revision)
        expect(call.steps).toBeUndefined()
        expect(revision).toMatch(/^[0-9a-f]{40}$/)
        if (process.env.XOVA_ACTIONS_ROOT) {
          const path = target.replace('xova-dev/actions/', '')
          const definition = parse(readFileSync(resolve(process.env.XOVA_ACTIONS_ROOT, path, ...(path.startsWith('actions/') ? ['action.yml'] : [])), 'utf8'))
          const contract = definition.on?.workflow_call || definition
          for (const field of Object.keys(call.with || {})) expect(contract.inputs).toHaveProperty(field)
          for (const [field, value] of Object.entries(contract.inputs)) {
            if (value.required)
              expect(call.with).toHaveProperty(field)
          }
        }
      }
    }
  }
  expect(references).toHaveLength(5)
  expect(new Set(references).size).toBe(1)
  expect(publish.jobs.release['continue-on-error']).toBeUndefined()
  expect(publish.jobs.release.with['expected-sha']).toBe(expression('needs.checks.outputs.source-sha || needs.ci.outputs.source-sha'))
  if (process.env.XOVA_ACTIONS_ROOT) {
    const template = readFileSync(resolve(process.env.XOVA_ACTIONS_ROOT, 'examples/matrix/publish.yml'), 'utf8').replaceAll('@v1', `@${references[0]}`)
    expect(publish).toEqual(parse(template))
    const { parseProjectConfig } = await import(pathToFileURL(resolve(process.env.XOVA_ACTIONS_ROOT, 'dist/project-config.mjs')).href)
    for (const task of ['code', 'docs', 'release', 'recovery', 'deploy'])
      expect(() => parseProjectConfig(config, task)).not.toThrow()
  }
})

it('wires optional CI reuse to full product fallback and exact-source publication', () => {
  expect(Object.keys(publish.jobs)).toEqual(['ci', 'ci-status', 'checks', 'release'])
  expect(publish.jobs.ci.permissions).toEqual({ contents: 'read', actions: 'read' })
  expect(publish.jobs.ci['continue-on-error']).toBe(true)
  const lookup = publish.jobs.ci.steps.at(-1)
  expect(lookup.id).toBe('ci')
  expect(lookup.uses.split('@')[0]).toBe('xova-dev/actions/actions/checked-ci')
  expect(lookup.with).toEqual({ 'expected-sha': expression('github.sha') })
  expect(publish.jobs.ci.outputs).toEqual({
    'source-sha': expression('steps.ci.outcome == \'success\' && steps.ci.outputs.source-sha || \'\''),
    'input-error': expression('steps.ci.outputs.input-error'),
  })
  const report = publish.jobs['ci-status']
  expect(report.needs).toBe('ci')
  expect(report.permissions).toEqual({})
  expect(report.if).toBe(expression('!cancelled() && (needs.ci.outputs.input-error == \'true\' || needs.ci.result != \'success\' || needs.ci.outputs.source-sha != github.sha)'))
  expect(report['continue-on-error']).toBe(expression('needs.ci.outputs.input-error != \'true\''))
  expect(report.steps[0].env.INPUT_ERROR).toBe(expression('needs.ci.outputs.input-error'))
  expect(publish.jobs.checks.needs).toBe('ci')
  expect(publish.jobs.checks.if).toBe(expression('!cancelled() && needs.ci.result != \'skipped\' && needs.ci.outputs.input-error != \'true\' && (needs.ci.result != \'success\' || needs.ci.outputs.source-sha != github.sha)'))
  expect(publish.jobs.release.needs).toEqual(['ci', 'checks'])
  expect(publish.jobs.release.if).toBe(expression('!cancelled() && needs.ci.result != \'skipped\' && needs.ci.outputs.input-error != \'true\' && ((needs.checks.result == \'success\' && needs.checks.outputs.source-sha == github.sha) || (needs.ci.result == \'success\' && needs.checks.result == \'skipped\' && needs.ci.outputs.source-sha == github.sha))'))
})

it('gates exact-source Linux hosts and Windows contracts without default app acceptance', () => {
  for (const call of [ci.jobs.code, publish.jobs.checks]) {
    expect(call.uses).toBe('./.github/workflows/checks.yml')
    expect(call.with['source-sha']).toBe(expression('github.sha'))
  }
  expect(checks.on.workflow_call.inputs['detect-changes'].default).toBe(false)
  expect(ci.jobs.code.with['detect-changes']).toBe(true)
  expect(publish.jobs.checks.with['detect-changes']).toBeUndefined()
  expect(checks.jobs.quality.with['source-sha']).toBe(expression('inputs.source-sha'))
  const rows = checks.jobs.compatibility.strategy.matrix.include
  expect(rows).toHaveLength(3)
  expect(rows.filter(row => row.profile === 'full')).toEqual([{ os: 'ubuntu-latest', node: '24.x', profile: 'full' }])
  expect(rows.filter(row => row.os === 'windows-latest')).toEqual([{ os: 'windows-latest', node: '24.x', profile: 'platform' }])
  expect(rows).toContainEqual({ os: 'ubuntu-latest', node: '22.18.0', profile: 'platform' })
  expect(checks.jobs.electron).toBeUndefined()
  for (const job of [checks.jobs.compatibility]) {
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.needs).toBe('quality')
    expect(job.if).toBe('needs.quality.outputs.code-changed == \'true\'')
    expect(job.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref).toBe(expression('inputs.source-sha'))
  }
  for (const job of [checks.jobs.quality, ci.jobs.code, publish.jobs.checks])
    expect(job['continue-on-error']).toBeUndefined()
  expect(checks.jobs.compatibility.steps.map(step => step.run)).toContain('pnpm test')
  expect(checks.jobs.compatibility.steps.map(step => step.run)).toContain('pnpm install --frozen-lockfile')
  const pack = checks.jobs.compatibility.steps.find(step => step.run?.includes('pnpm test:pack'))
  expect(pack.run).toBe(`pnpm test:pack --profile ${expression('inputs.full && \'full\' || matrix.profile')}`)
  expect(ci.jobs.code.with.full).toBe(expression('inputs.full || false'))
  expect(Object.values(checks.jobs).flatMap(job => job.steps || []).some(step => step.run?.includes('test:electron-web'))).toBe(false)
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  expect(manifest.scripts['test:electron-web']).toBe('node scripts/electron-web.mjs')
  expect(ci.jobs.changes).toBeUndefined()
})

it('uses the runner temporary directory for installed package consumers', () => {
  const root = mkdtempSync(join(tmpdir(), 'matrix-ci-temp-'))
  const runnerTemporary = join(root, 'runner')
  const systemTemporary = join(root, 'system')
  try {
    const compatibility = checks.jobs.compatibility.steps.filter(step => step.run?.includes('pnpm test:pack'))
    expect(compatibility).toHaveLength(1)
    for (const step of compatibility) {
      for (const key of ['TMPDIR', 'TEMP', 'TMP'])
        expect(step.env?.[key]).toBe(expression('runner.temp'))
      const env = Object.fromEntries(Object.entries(step.env || {}).map(([key, value]) => [key, value.replaceAll(expression('runner.temp'), runnerTemporary)]))
      const selected = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").tmpdir())'], {
        encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: runnerTemporary, TMPDIR: systemTemporary, TEMP: systemTemporary, TMP: systemTemporary, ...env },
      })
      expect(resolve(selected)).toBe(resolve(runnerTemporary))
    }
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('declares commands and documentation settings once for all four paths', () => {
  expect(config.schemaVersion).toBe(1)
  expect(config.code['check-command']).toContain('pnpm release:check')
  expect(config.code['docs-only-command']).toContain('pnpm lint')
  for (const field of ['check-command', 'docs-only-command'])
    expect(config.code[field]).toContain('test/scripts/release-workflows.test.js')
  expect(config.npm['verify-command']).toBe('pnpm build')
  expect(config.npm['package-verify-command']).toBe('pnpm test:pack --profile package')
  expect(config.docs).toMatchObject({ 'provider': 'pages', 'environment-name': 'github-pages', 'concurrency-group': 'github-pages', 'deployment-policy': 'latest-stable' })
  for (const call of [checks.jobs.quality, ci.jobs.docs, publish.jobs.release, recover.jobs.recover]) {
    expect(call.with['config-file'] ?? '.github/xova.json').toBe('.github/xova.json')
    expect(call.with['docs-build-command']).toBeUndefined()
    expect(call.with['verify-command']).toBeUndefined()
    expect(call.with.toolchain).toBeUndefined()
  }
  expect(publish.jobs.release.with['deploy-docs']).toBe(expression('github.event_name == \'release\' && !github.event.release.prerelease'))
  expect(Object.keys(recover.jobs)).toEqual(['recover'])
  expect(recover.jobs.recover.with['published-sha']).toBe(expression('inputs.published-sha'))
  expect(Object.keys(ci.jobs)).toEqual(['code', 'docs'])
  expect(readdirSync(new URL('../../.github/workflows/', import.meta.url))).not.toContain('docs.yml')
  expect(ci.permissions).toEqual({ contents: 'read' })
  expect(ci.on.pull_request).toBeNull()
  expect(ci.on.push).toEqual({ branches: ['main'] })
  expect(ci.jobs.docs.with).toEqual({ 'kind': 'docs', 'source-sha': expression('github.sha') })
  for (const job of [ci.jobs.code, ci.jobs.docs]) {
    expect(job.needs).toBeUndefined()
    expect(job.if).toBeUndefined()
    expect(job.environment).toBeUndefined()
    expect(job.secrets).toBeUndefined()
    expect(job.permissions).toBeUndefined()
  }
  expect(config.setup.cache).toEqual({ pnpm: 'pnpm-lock.yaml' })
  expect(config.docs.cache).toBeUndefined()
  expect(checks.permissions).toEqual({ contents: 'read' })
  expect(publish.permissions).toEqual({ contents: 'read' })
  expect(publish.jobs.checks.permissions).toBeUndefined()
  expect(publish.jobs.release.permissions).toEqual({ 'contents': 'read', 'id-token': 'write', 'pages': 'write' })
  expect(recover.permissions).toEqual({ contents: 'read' })
  expect(recover.jobs.recover.permissions).toEqual({ 'contents': 'read', 'id-token': 'write', 'pages': 'write' })
})
