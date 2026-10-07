import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import compatibility from '../../scripts/compatibility-matrix.json' with { type: 'json' }
import { runConsumers, selectCompatibility } from '../../scripts/pack-matrix.mjs'

it('preserves the complete release matrix and Electron combinations', () => {
  expect(selectCompatibility('full')).toEqual(compatibility)
  for (const profile of ['daily', 'platform'])
    expect(selectCompatibility(profile).electron).toEqual(compatibility.electron)
  expect(() => selectCompatibility('typo')).toThrow('Unknown compatibility profile')
})

it('covers daily major boundaries and every esbuild minor without adding untested pins', () => {
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

it('keeps both overall host boundaries in the platform matrix', () => {
  for (const [host, pins] of Object.entries(compatibility.hosts))
    expect(selectCompatibility('platform').hosts[host]).toEqual([pins[0], pins.at(-1)])
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
