import compatibility from './compatibility-matrix.json' with { type: 'json' }

const nuxtLayers = ['ts-mjs', 'mjs-ts', 'explicit-candidates', 'explicit-outside', 'explicit-symlink']

export function selectCompatibility(profile) {
  if (profile === 'daily')
    throw new Error('The daily profile has retired. Use full for compatibility or package for tarball acceptance.')
  if (!['full', 'package', 'platform'].includes(profile))
    throw new Error(`Unknown compatibility profile: ${profile}`)
  const hosts = Object.fromEntries(Object.entries(compatibility.hosts).map(([host, pins]) => {
    const versions = [...pins].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    if (profile === 'full')
      return [host, versions]
    if (profile === 'platform')
      return [host, host === 'vite' ? [versions.at(-1)] : []]
    return [host, [versions.at(-1)]]
  }))
  const extended = profile === 'full'
  return {
    ...compatibility,
    hosts,
    configSelection: profile !== 'package',
    electron: {
      ...compatibility.electron,
      combinations: profile === 'platform' ? [] : profile === 'package' ? compatibility.electron.combinations.slice(-1) : compatibility.electron.combinations,
    },
    nuxt: {
      ...compatibility.nuxt,
      versions: profile === 'platform' ? [] : profile === 'package' ? compatibility.nuxt.versions.slice(-1) : compatibility.nuxt.versions,
      checks: {
        extended,
        layers: extended ? [...nuxtLayers] : [],
      },
    },
  }
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
