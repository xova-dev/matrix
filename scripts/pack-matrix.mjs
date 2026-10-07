import compatibility from './compatibility-matrix.json' with { type: 'json' }

export function selectCompatibility(profile) {
  if (!['full', 'daily', 'platform'].includes(profile))
    throw new Error(`Unknown compatibility profile: ${profile}`)
  const hosts = Object.fromEntries(Object.entries(compatibility.hosts).map(([host, pins]) => {
    const versions = [...pins].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    if (profile === 'full')
      return [host, versions]
    if (profile === 'platform')
      return [host, [...new Set([versions[0], versions.at(-1)])]]
    const groups = Map.groupBy(versions, version => version.split('.').slice(0, host === 'esbuild' ? 2 : 1).join('.'))
    const selected = [...groups.values()].flatMap(group => host === 'esbuild' ? [group.at(-1)] : [group[0], group.at(-1)])
    return [host, [...new Set([versions[0], ...selected])]]
  }))
  return { ...compatibility, hosts }
}

// Drain every worker before allowing the caller to remove consumer directories.
export async function runConsumers(consumers, concurrency, verify) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error('Package test concurrency must be an integer from 1 to 4')
  const queue = consumers.values()
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, consumers.length) }, async () => {
    const failures = []
    for (const consumer of queue) {
      try {
        await verify(consumer)
      }
      catch (error) {
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Consumer checks failed')
  }))
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length)
    throw new AggregateError(failures, 'Package compatibility failed')
}
