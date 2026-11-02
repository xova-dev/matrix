import { performance } from 'node:perf_hooks'
import { assertNormalProcessExit, expectFailure } from './pack-fixtures.mjs'

export function createPackageTimings() {
  const started = performance.now()
  const records = []
  const seconds = milliseconds => (milliseconds / 1000).toFixed(1)
  return {
    async measure(consumer, phase, operation, { rejection, allowSuccess = false } = {}) {
      const start = performance.now()
      let outcome = 'failed'
      try {
        const pending = operation()
        const result = await (rejection ? pending.catch(error => error) : pending)
        if (rejection)
          assertNormalProcessExit(result)
        if (rejection && !(allowSuccess && result.exitCode === 0)) {
          await expectFailure(Promise.resolve(result), rejection, phase)
          outcome = 'expected rejection'
        }
        else {
          outcome = 'passed'
        }
        return result
      }
      finally {
        const duration = performance.now() - start
        records.push({ consumer, phase, duration, outcome })
        console.log(`Package timing: ${consumer} ${phase} ${seconds(duration)}s (${outcome})`)
      }
    },
    report() {
      console.log(`Package elapsed: ${seconds(performance.now() - started)}s (including pack and CLI smoke)`)
      const phases = new Map()
      const consumers = new Map()
      const outcomes = new Map()
      for (const { consumer, phase, duration, outcome } of records) {
        phases.set(phase, (phases.get(phase) ?? 0) + duration)
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1)
        if (phase !== 'install')
          consumers.set(consumer, (consumers.get(consumer) ?? 0) + duration)
      }
      if (outcomes.size)
        console.log(`Package outcomes: ${[...outcomes].map(([outcome, count]) => `${outcome} ${count}`).join(', ')}`)
      if (phases.size)
        console.log(`Package phase totals (cumulative across concurrent consumers): ${[...phases].map(([phase, duration]) => `${phase} ${seconds(duration)}s`).join(', ')}`)
      const slowest = [...consumers].sort((a, b) => b[1] - a[1]).slice(0, 5)
      if (slowest.length)
        console.log(`Slowest consumers (excluding install): ${slowest.map(([consumer, duration]) => `${consumer} ${seconds(duration)}s`).join(', ')}`)
    },
  }
}
