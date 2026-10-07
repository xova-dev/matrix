import { performance } from 'node:perf_hooks'

export function createPackageTimings() {
  const started = performance.now()
  const records = []
  const seconds = milliseconds => (milliseconds / 1000).toFixed(1)
  return {
    async measure(consumer, phase, operation) {
      const start = performance.now()
      let passed = false
      try {
        const result = await operation()
        passed = true
        return result
      }
      finally {
        const duration = performance.now() - start
        records.push({ consumer, phase, duration })
        console.log(`Package timing: ${consumer} ${phase} ${seconds(duration)}s (${passed ? 'passed' : 'failed'})`)
      }
    },
    report() {
      console.log(`Package elapsed: ${seconds(performance.now() - started)}s (including pack and CLI smoke)`)
      const phases = new Map()
      const consumers = new Map()
      for (const { consumer, phase, duration } of records) {
        phases.set(phase, (phases.get(phase) ?? 0) + duration)
        if (phase !== 'install')
          consumers.set(consumer, (consumers.get(consumer) ?? 0) + duration)
      }
      if (phases.size)
        console.log(`Package phase totals (cumulative across concurrent consumers): ${[...phases].map(([phase, duration]) => `${phase} ${seconds(duration)}s`).join(', ')}`)
      const slowest = [...consumers].sort((a, b) => b[1] - a[1]).slice(0, 5)
      if (slowest.length)
        console.log(`Slowest consumers (excluding install): ${slowest.map(([consumer, duration]) => `${consumer} ${seconds(duration)}s`).join(', ')}`)
    },
  }
}
