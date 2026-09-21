import { describe, expect, it } from 'vitest'
import { parseArgs, validateCliArgs } from '../src/cli-args.js'

describe('cli argument parsing', () => {
  it('parses supported positional arguments and options', () => {
    expect(parseArgs(['build', 'app', '--variant', 'web,desktop', '--env', 'staging', '--target', 'build', '--help']))
      .toEqual({ command: 'build', product: 'app', variants: ['web', 'desktop'], env: 'staging', target: 'build', help: true })
  })

  it('supports the existing aliases', () => {
    expect(parseArgs(['dev', 'app', '-v', 'web', '--mode', 'development']))
      .toEqual({ command: 'dev', product: 'app', variants: ['web'], env: 'development' })
  })

  it('supports explicit product selection without positional ambiguity', () => {
    expect(parseArgs(['--product', 'app', '--target', 'preview', '--env', 'staging']))
      .toEqual({ product: 'app', target: 'preview', env: 'staging', variants: [] })
  })

  it('rejects unknown options, missing values, and extra positionals', () => {
    expect(() => parseArgs(['dev', 'app', '--unknown'])).toThrow('Unknown option: --unknown')
    expect(() => parseArgs(['build', 'app', '--env'])).toThrow('Option --env requires a value')
    expect(() => parseArgs(['dev', 'app', '--variant'])).toThrow('Option --variant requires a value')
    expect(() => parseArgs(['dev', 'app', 'extra'])).toThrow('Unexpected argument: extra')
  })

  it('rejects ambiguous or empty option values', () => {
    expect(() => parseArgs(['dev', 'app', '--variant', 'web,,desktop'])).toThrow('contains an empty variant name')
    expect(() => parseArgs(['build', 'app', '--env', 'staging', '--mode', 'production'])).toThrow('Duplicate option: --env')
  })

  it('rejects options that do not apply to a command', () => {
    expect(() => validateCliArgs(parseArgs(['dev', 'app', '--target', 'build'])))
      .toThrow('Target is already selected by command dev')
    expect(() => validateCliArgs(parseArgs(['help', '--env', 'staging'])))
      .toThrow('Help does not accept execution options')
  })
})
