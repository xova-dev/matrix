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

it('preserves full host coverage and daily framework endpoints', () => {
  const { nuxt: { checks, ...nuxt }, ...full } = selectCompatibility('full')
  expect({ ...full, nuxt }).toEqual(compatibility)
  expect(checks.extended).toBe(true)
  for (const profile of ['full', 'daily']) {
    const selected = selectCompatibility(profile)
    expect(Object.keys(selected.hosts)).toEqual(Object.keys(compatibility.hosts))
    expect(selected.electron).toEqual(compatibility.electron)
    const { checks: _, ...selectedNuxt } = selected.nuxt
    expect(selectedNuxt).toEqual(compatibility.nuxt)
  }
  expect(() => selectCompatibility('typo')).toThrow('Unknown compatibility profile')
})

it('keeps daily Nuxt paths within full coverage while platform needs no Nuxt installation', () => {
  const full = selectCompatibility('full').nuxt.checks
  const daily = selectCompatibility('daily').nuxt.checks
  const platform = selectCompatibility('platform').nuxt.checks
  expect(platform.layers).toEqual([])
  expect(platform.extended).toBe(false)
  expect(daily.extended).toBe(false)
  expect(daily.layers).toContain('explicit-outside')
  expect(daily.layers).toContain('explicit-symlink')
  expect(daily.layers.length).toBeGreaterThan(0)
  expect(full.layers.length).toBeGreaterThan(daily.layers.length)
  expect(full.layers).toEqual([...new Set(full.layers)])
  expect(daily.layers).toEqual([...new Set(daily.layers)])
  expect(daily.layers.every(scenario => full.layers.includes(scenario))).toBe(true)
})

it('keeps manifest pins ordered and unique for native config boundary fixtures', () => {
  for (const pins of Object.values(compatibility.hosts)) {
    expect(pins.length).toBeGreaterThan(1)
    expect(pins).toEqual([...new Set(pins)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })))
  }
})

it('covers daily major boundaries and retained esbuild minors without adding untested pins', () => {
  const daily = selectCompatibility('daily')
  for (const [host, pins] of Object.entries(compatibility.hosts)) {
    const selected = daily.hosts[host]
    expect(selected.every(pin => pins.includes(pin))).toBe(true)
    expect(new Set(selected).size).toBe(selected.length)
    expect(selected).toContain(pins[0])
    const groups = Map.groupBy(pins, pin => pin.split('.').slice(0, host === 'esbuild' ? 2 : 1).join('.'))
    for (const group of groups.values()) {
      expect(selected).toContain(group.at(-1))
      if (host !== 'esbuild')
        expect(selected).toContain(group[0])
      for (const pin of selected.filter(pin => group.includes(pin)))
        expect(pin === group.at(-1) || pin === (host === 'esbuild' ? pins[0] : group[0])).toBe(true)
    }
  }
})

it('selects one real Vite consumer without repeated framework matrices for platform contracts', () => {
  const selected = selectCompatibility('platform')
  expect(selected.hosts.vite).toEqual([compatibility.hosts.vite.at(-1)])
  expect(Object.values(selected.hosts).flat()).toHaveLength(1)
  expect(selected.electron.combinations).toEqual([])
  expect(selected.nuxt.versions).toEqual([])
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
