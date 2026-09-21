import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli.js'

describe('cli entry', () => {
  it('prints help without loading a workspace configuration', async () => {
    const output: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => output.push(args.join(' '))
    try {
      await runCli(['--help'])
    }
    finally {
      console.log = originalLog
    }
    expect(output[0]).toContain('matrix')
  })

  it('rejects invalid command options before loading a workspace configuration', async () => {
    await expect(runCli(['doctor', '--target', 'build']))
      .rejects
      .toThrow('doctor only accepts --env')
  })
})
