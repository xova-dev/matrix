import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parse } from 'yaml'
import { checkParentCI, checkReleaseCommit, requiredJobs } from '../../scripts/check-release.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'matrix-release-'))
  directories.push(directory)
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
  git('init', '-q', '--initial-branch=main')
  git('config', 'user.name', 'Matrix Test')
  git('config', 'user.email', 'test@example.com')
  git('config', 'commit.gpgsign', 'false')
  const commit = (files) => {
    for (const [file, content] of Object.entries(files))
      writeFileSync(join(directory, file), content)
    git('add', '.')
    git('commit', '-qm', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  const base = commit({ 'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0' }) })
  return { git, commit, base }
}

it('accepts an independent version/changelog commit and returns its exact parent', () => {
  const { git, commit, base } = repository()
  commit({ 'package.json': '{"version":"1.0.1","name":"fixture"}', 'CHANGELOG.md': 'release' })
  expect(checkReleaseCommit(git, 'v1.0.1')).toBe(base)
  expect(() => checkReleaseCommit(git, 'v1.0.2')).toThrow('matching')
  expect(() => checkReleaseCommit(git, '')).toThrow('release tag')
})

it('rejects code changes, other package changes, and unchanged versions', () => {
  const cases = [
    { 'package.json': '{"name":"fixture","version":"1.0.1"}', 'source.js': 'code' },
    { 'package.json': '{"name":"fixture","version":"1.0.1","dependencies":{"vite":"5"}}' },
    { 'package.json': '{ "name":"fixture","version":"1.0.0"}' },
    { 'CHANGELOG.md': 'release' },
  ]
  for (const files of cases) {
    const { git, commit } = repository()
    commit(files)
    expect(() => checkReleaseCommit(git, 'v1.0.1')).toThrow()
  }
})

it('rejects root and merge commits', () => {
  const { git, commit } = repository()
  expect(() => checkReleaseCommit(git, 'v1.0.0')).toThrow('exactly one parent')
  git('checkout', '-qb', 'release')
  commit({ 'package.json': '{"name":"fixture","version":"1.0.1"}' })
  git('checkout', '-q', 'main')
  git('merge', '--no-ff', '-qm', 'release', 'release')
  expect(() => checkReleaseCommit(git, 'v1.0.1')).toThrow('exactly one parent')
})

const successful = { id: 1, head_sha: 'parent', event: 'push', status: 'completed', conclusion: 'success' }
const passedJobs = requiredJobs.map(name => ({ name, conclusion: 'success' }))
const api = (runs, jobs = passedJobs) => async path => path.includes('/jobs?') ? { jobs } : { workflow_runs: runs }

it('keeps the publication gate aligned with actual CI job names and matrix versions', () => {
  const { jobs } = parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  const names = ['quality', 'compatibility', 'electron'].flatMap((id) => {
    const job = jobs[id]
    const combinations = Object.entries(job.strategy?.matrix ?? {}).reduce(
      (rows, [key, values]) => rows.flatMap(row => values.map(value => ({ ...row, [key]: value }))),
      [{}],
    )
    return combinations.map(matrix => job.name.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key) => matrix[key]))
  })
  expect([...requiredJobs].sort()).toEqual(names.sort())
})

it('accepts successful push and manual CI on the exact parent', async () => {
  await expect(checkParentCI('parent', api([successful]))).resolves.toBeUndefined()
  await expect(checkParentCI('parent', api([{ ...successful, event: 'workflow_dispatch' }]))).resolves.toBeUndefined()
})

it('does not substitute older, pending, PR, or unrelated CI for the parent run', async () => {
  for (const runs of [
    [],
    [{ ...successful, head_sha: 'other' }],
    [{ ...successful, event: 'pull_request' }],
    [{ ...successful, status: 'in_progress', conclusion: null }],
    [successful, { ...successful, id: 2, conclusion: 'failure' }],
  ]) {
    await expect(checkParentCI('parent', api(runs))).rejects.toThrow('Parent CI must finish successfully')
  }
  await expect(checkParentCI('parent', async () => {
    throw new Error('API unavailable')
  })).rejects.toThrow('API unavailable')
})

it('rejects missing, skipped, or failed test jobs despite a green workflow', async () => {
  for (const conclusion of ['skipped', 'failure', 'cancelled']) {
    const jobs = passedJobs.map(job => job.name === 'ubuntu-latest / Node 24.x' ? { ...job, conclusion } : job)
    await expect(checkParentCI('parent', api([successful], jobs))).rejects.toThrow('ubuntu-latest / Node 24.x')
  }
  await expect(checkParentCI('parent', api([successful], passedJobs.slice(0, -1)))).rejects.toThrow('required jobs')
})
