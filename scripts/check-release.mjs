import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

// Keep these job names aligned with ci.yml. A green docs-only run is insufficient.
export const requiredJobs = [
  'Lint and types',
  ...['ubuntu-latest', 'macos-latest', 'windows-latest'].flatMap(os => [
    `${os} / Node 22.18.0`,
    `${os} / Node 24.x`,
    `Electron / ${os}`,
  ]),
]

export function checkReleaseCommit(git, tag) {
  const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')
  if (parents.length !== 2)
    throw new Error('Release must be a separate commit with exactly one parent.')
  const parent = parents[1]
  const files = git('diff', '--name-only', '--no-renames', '-z', parent, 'HEAD').split('\0').filter(Boolean)
  if (!files.includes('package.json') || files.some(file => !['package.json', 'CHANGELOG.md'].includes(file)))
    throw new Error('Release may change only package.json version and CHANGELOG.md.')
  const { version: before, ...previous } = JSON.parse(git('show', `${parent}:package.json`))
  const { version, ...current } = JSON.parse(git('show', 'HEAD:package.json'))
  if (typeof version !== 'string' || before === version || !isDeepStrictEqual(previous, current))
    throw new Error('Only the version field may change in package.json.')
  if (tag !== `v${version}`)
    throw new Error('Publish must run from a release tag matching package.json version.')
  return parent
}

export async function checkParentCI(parent, api) {
  const { workflow_runs: runs } = await api(`actions/workflows/ci.yml/runs?head_sha=${parent}&per_page=100`)
  const run = runs.filter(run => run.head_sha === parent && ['push', 'workflow_dispatch'].includes(run.event))
    .sort((a, b) => b.id - a.id)[0]
  if (run?.status !== 'completed' || run.conclusion !== 'success')
    throw new Error('Parent CI must finish successfully. Run CI on the parent commit, then rerun Publish.')
  const { jobs } = await api(`actions/runs/${run.id}/jobs?per_page=100`)
  const missing = requiredJobs.filter(name => !jobs.some(job => job.name === name && job.conclusion === 'success'))
  if (missing.length)
    throw new Error(`Parent CI did not pass required jobs: ${missing.join(', ')}. Run CI manually on the parent, then rerun Publish.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const parent = checkReleaseCommit(git, process.env.RELEASE_TAG)
  await checkParentCI(parent, path => JSON.parse(execFileSync('gh', [
    'api',
    `repos/${process.env.GITHUB_REPOSITORY}/${path}`,
  ], { encoding: 'utf8', timeout: 30000 })))
  console.log(`Release conditions satisfied; code verified at ${parent}.`)
}
