import { describe, expect, it } from 'vitest'
import { parseArgs, validateCliArgs } from '../src/cli-args.js'

describe('cli argument parsing', () => {
  it('parses positional execution with explicit scope and environment', () => {
    expect(parseArgs(['build', 'app', '--variant', 'web,desktop', '--env', 'staging']))
      .toEqual({ command: 'build', product: 'app', variants: ['web', 'desktop'], env: 'staging' })
  })

  it('normalizes long and short named selections, including incomplete commands', () => {
    const expected = { product: 'app', target: 'preview', env: 'staging', variants: [] }
    expect(parseArgs(['--product', 'app', '--target', 'preview', '--env', 'staging'])).toEqual(expected)
    expect(parseArgs(['-p', 'app', '-t', 'preview', '-e', 'staging'])).toEqual(expected)
    expect(parseArgs(['-p', 'app'])).toEqual({ product: 'app', variants: [] })
  })

  it('supports equals syntax and merges repeatable variants without duplicates', () => {
    expect(parseArgs(['plan', '-p=app', '-t=build', '-e=qa', '-v', 'web', '--variant=desktop,web']))
      .toEqual({ command: 'plan', product: 'app', target: 'build', env: 'qa', variants: ['web', 'desktop'] })
    expect(parseArgs(['plan', '--product=app', '--target=build', '--env=qa', '--variant', 'desktop']))
      .toEqual({ command: 'plan', product: 'app', target: 'build', env: 'qa', variants: ['desktop'] })
  })

  it('rejects unknown and removed options', () => {
    for (const flag of ['--unknown', '--mode', '--mode=staging', '--no-env'])
      expect(() => parseArgs(['dev', 'app', flag])).toThrow(/Unknown option/)
  })

  it('rejects missing or empty values and extra positionals', () => {
    for (const args of [['-p'], ['-t'], ['-e'], ['-v'], ['--env='], ['--env', ' '], ['--env', '--variant', 'web'], ['dev', 'app', 'extra']])
      expect(() => parseArgs(args)).toThrow()
  })

  it('rejects duplicate selections across aliases and positional products', () => {
    for (const [short, long] of [['-p', '--product'], ['-t', '--target'], ['-e', '--env']]) {
      expect(() => parseArgs([short!, 'first', long!, 'second'])).toThrow('Duplicate option')
      expect(() => parseArgs([`${long!}=first`, `${short!}=second`])).toThrow('Duplicate option')
    }
    expect(() => parseArgs(['dev', 'app', '-p', 'other'])).toThrow('Product was provided more than once')
  })

  it('rejects empty entries in a variant list', () => {
    expect(() => parseArgs(['dev', 'app', '-v', 'web,,desktop'])).toThrow('contains an empty variant name')
  })

  it('rejects options that do not apply to a command', () => {
    expect(() => validateCliArgs(parseArgs(['dev', 'app', '-t', 'build'])))
      .toThrow('Target is already selected')
    expect(() => validateCliArgs(parseArgs(['prepare', '-v', 'web'])))
      .toThrow('prepare only accepts a product and --env')
    expect(() => validateCliArgs(parseArgs(['doctor', '-p', 'app'])))
      .toThrow('doctor only accepts --env')
  })
})
