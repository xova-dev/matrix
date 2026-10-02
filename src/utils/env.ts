import type { EnvMap } from '../types.js'
import process from 'node:process'

export function mergeEnv(...maps: Array<EnvMap | undefined>): EnvMap {
  return Object.assign({}, ...maps.filter(Boolean))
}

export function currentProcessEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
