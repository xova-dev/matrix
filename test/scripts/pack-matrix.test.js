import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import compatibility from '../../scripts/compatibility-matrix.json' with { type: 'json' }
import { runConsumers, selectCompatibility } from '../../scripts/pack-matrix.mjs'

it('rejects a relative external tarball before packing or installing', () => {
  const result = spawnSync(process.execPath, ['scripts/pack-smoke.mjs', '--profile', 'platform'], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, TARBALL: 'relative.tgz' },
  })
  expect(result.status).not.toBe(0)
  expect(result.stdout + result.stderr).toContain('TARBALL must be an absolute path')
})

it('preserves all manifest versions and full config regressions', () => {
  const { configSelection, nuxt: { checks, ...nuxt }, ...full } = selectCompatibility('full')
  expect({ ...full, nuxt }).toEqual(compatibility)
  expect(configSelection).toBe(true)
  expect(checks.extended).toBe(true)
  expect(checks.layers).toEqual(['ts-mjs', 'mjs-ts', 'explicit-candidates', 'explicit-outside', 'explicit-symlink'])
  expect(() => selectCompatibility('typo')).toThrow('Unknown compatibility profile')
  expect(() => selectCompatibility('daily')).toThrow('Use full for compatibility or package for tarball acceptance')
})

it('selects a real consumer of every host for package acceptance without repeating version and config matrices', () => {
  const selected = selectCompatibility('package')
  for (const [host, pins] of Object.entries(compatibility.hosts))
    expect(selected.hosts[host]).toEqual([pins.at(-1)])
  expect(selected.electron.combinations).toEqual(compatibility.electron.combinations.slice(-1))
  expect(selected.nuxt.versions).toEqual(compatibility.nuxt.versions.slice(-1))
  expect(selected.configSelection).toBe(false)
  expect(selected.nuxt.checks).toEqual({ extended: false, layers: [] })
})

it('keeps manifest pins ordered and unique for native config boundary fixtures', () => {
  for (const pins of Object.values(compatibility.hosts)) {
    expect(pins.length).toBeGreaterThan(1)
    expect(pins).toEqual([...new Set(pins)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })))
  }
})

it('selects one real Vite consumer without repeated framework matrices for platform contracts', () => {
  const selected = selectCompatibility('platform')
  expect(selected.hosts.vite).toEqual([compatibility.hosts.vite.at(-1)])
  expect(Object.values(selected.hosts).flat()).toHaveLength(1)
  expect(selected.electron.combinations).toEqual([])
  expect(selected.nuxt.versions).toEqual([])
  expect(selected.configSelection).toBe(true)
  expect(selected.nuxt.checks).toEqual({ extended: false, layers: [] })
})

it('bounds concurrency and finishes every consumer before reporting failures', async () => {
  let active = 0
  let peak = 0
  const finished = []
  await expect(runConsumers([0, 1, 2, 3, 4], 2, async (consumer) => {
    active++
    peak = Math.max(peak, active)
    await setImmediate()
    active--
    finished.push(consumer)
    if (consumer === 0)
      throw new Error('fixture failure')
  })).rejects.toThrow('Package compatibility failed')
  expect(peak).toBe(2)
  expect(active).toBe(0)
  expect(finished.sort()).toEqual([0, 1, 2, 3, 4])
  await expect(runConsumers([0], 0, () => {})).rejects.toThrow('concurrency')
})
