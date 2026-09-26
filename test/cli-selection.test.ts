import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { CANCEL_SYMBOL, multiselect, note, outro, select, settings } from '@clack/prompts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/cli-args.js'
import { resolveSelection, selectionCommand } from '../src/cli-selection.js'
import { runCli } from '../src/cli.js'

vi.mock('@clack/prompts', async importOriginal => ({
  ...await importOriginal<typeof import('@clack/prompts')>(),
  select: vi.fn(),
  multiselect: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
}))

const config = {
  env: { VITE_PASSCODE: 'fixture-private-value' },
  $env: { qa: { env: { VITE_ENDPOINT: 'qa-fixture' } } },
  projects: {
    web: { targets: { dev: 'web-dev', build: 'web-build' } },
    desktop: { targets: { dev: 'desktop-dev', build: 'desktop-build', credentials: 'generate-credentials' } },
  },
  products: {
    app: {
      name: 'Example app',
      variants: {
        web: 'web',
        desktop: { project: 'desktop', targets: { build: { dependsOn: ['web'] } } },
      },
    },
    other: { name: 'Other app', variants: { web: 'web' } },
  },
}

let cwd: string
let previousCwd: string
let stdinTTY: PropertyDescriptor | undefined
let stdoutTTY: PropertyDescriptor | undefined
let terminalOutput: string[]
let previousExitCode: typeof process.exitCode

function terminal(enabled: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: enabled })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: enabled })
}

async function executableTargets(targets: string[]): Promise<string> {
  await writeFile(path.join(cwd, 'record.mjs'), String.raw`
    import { appendFileSync } from 'node:fs';
    appendFileSync('executed.log', process.env.MATRIX_TARGET + '\n');
  `)
  await writeFile(path.join(cwd, 'matrix.config.json'), JSON.stringify({
    projects: { web: { targets: Object.fromEntries(targets.map(target => [target, 'node record.mjs'])) } },
    products: { app: { variants: { web: 'web' } } },
  }))
  return path.join(cwd, 'executed.log')
}

beforeEach(async () => {
  vi.resetAllMocks()
  vi.stubEnv('CI', '')
  vi.stubEnv('TERM', 'xterm-256color')
  vi.stubEnv('ACCESSIBLE', 'false')
  previousExitCode = process.exitCode
  terminalOutput = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    terminalOutput.push(String(chunk))
    return true
  })
  stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  terminal(true)
  previousCwd = process.cwd()
  cwd = await mkdtemp(path.join(os.tmpdir(), 'matrix-selection-'))
  await writeFile(path.join(cwd, 'matrix.config.json'), JSON.stringify(config))
  process.chdir(cwd)
})

afterEach(async () => {
  process.chdir(previousCwd)
  if (stdinTTY)
    Object.defineProperty(process.stdin, 'isTTY', stdinTTY)
  else
    Reflect.deleteProperty(process.stdin, 'isTTY')
  if (stdoutTTY)
    Object.defineProperty(process.stdout, 'isTTY', stdoutTTY)
  else
    Reflect.deleteProperty(process.stdout, 'isTTY')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = previousExitCode
  await rm(cwd, { recursive: true, force: true })
})

describe('cli selection and execution plans', () => {
  it('runs a complete command without prompts and resolves the same plan outside a TTY', async () => {
    const args = { command: 'build', product: 'app', variants: ['desktop'] }
    const direct = await resolveSelection(args)
    expect(select).not.toHaveBeenCalled()
    expect(terminalOutput).toEqual([])
    expect(direct).toMatchObject({ env: 'production', plan: { tasks: [{ id: 'app:web:build' }, { id: 'app:desktop:build' }] } })
    terminal(false)
    expect(await resolveSelection(args)).toEqual(direct)
  })

  it('completes a missing product without asking for an already selected action or environment', async () => {
    vi.mocked(select).mockResolvedValueOnce('app').mockResolvedValueOnce('run')
    const result = await resolveSelection({ command: 'build', variants: [] })
    expect(result).toMatchObject({ product: 'app', target: 'build', env: 'production' })
    expect(select).toHaveBeenCalledTimes(2)
  })

  it('discovers single-variant actions and makes their scope explicit', async () => {
    vi.mocked(select).mockResolvedValueOnce('app').mockResolvedValueOnce('credentials').mockResolvedValueOnce('run')
    const result = await resolveSelection({ variants: [] })
    expect(vi.mocked(select).mock.calls.flatMap(([options]) => options.options)).toContainEqual(expect.objectContaining({ value: 'credentials' }))
    expect(result).toMatchObject({ variants: ['desktop'], plan: { tasks: [{ id: 'app:desktop:credentials' }] } })
    expect(result!.plan.tasks).toHaveLength(1)
    expect(selectionCommand(result!)).toBe('matrix credentials app -v desktop -e development')
    await expect(resolveSelection({ command: 'credentials', product: 'app', variants: [] })).rejects.toThrow('--variant desktop')
  })

  it('adjusts scope and environment, includes dependencies, and matches the equivalent direct command', async () => {
    vi.mocked(select).mockResolvedValueOnce('build').mockResolvedValueOnce('variants').mockResolvedValueOnce('env').mockResolvedValueOnce('qa').mockResolvedValueOnce('details').mockResolvedValueOnce('back').mockResolvedValueOnce('run')
    vi.mocked(multiselect).mockResolvedValueOnce(['desktop'])
    const result = await resolveSelection({ product: 'app', variants: [] })
    expect(result).toEqual(await resolveSelection(parseArgs(selectionCommand(result!).split(' ').slice(1))))
    expect(result).toEqual(await resolveSelection(parseArgs(selectionCommand(result!, true).split(' ').slice(1))))
    expect(result!.plan.tasks[1]!.env).toMatchObject({ VITE_ENDPOINT: 'qa-fixture', NODE_ENV: 'production' })
    expect(note).toHaveBeenCalledTimes(1)
    expect(vi.mocked(note).mock.calls[0]![0]).toContain('app:web:build')
    const output = terminalOutput.join('')
    expect(output.split('\u001B[?1049h')).toHaveLength(2)
    expect(output.lastIndexOf('\u001B[?1049l')).toBeGreaterThan(output.lastIndexOf('\u001B[?1049h'))
    expect(output).not.toContain('\u001B[3J')
  })

  it('resets adjusted scope and environment when returning to action selection', async () => {
    vi.mocked(select).mockResolvedValueOnce('build').mockResolvedValueOnce('variants').mockResolvedValueOnce('env').mockResolvedValueOnce('qa').mockResolvedValueOnce('back').mockResolvedValueOnce('dev').mockResolvedValueOnce('run')
    vi.mocked(multiselect).mockResolvedValueOnce(['desktop'])
    const result = await resolveSelection({ product: 'app', variants: [] })
    expect(result).toMatchObject({ target: 'dev', variants: [], env: 'development' })
    expect(result!.plan.tasks.map(task => task.id)).toEqual(['app:web:dev', 'app:desktop:dev'])
  })

  it('auto-selects a sole product but still offers the action summary in the wizard', async () => {
    await writeFile(path.join(cwd, 'matrix.config.json'), JSON.stringify({ ...config, products: { app: config.products.app } }))
    vi.mocked(select).mockResolvedValueOnce('dev').mockResolvedValueOnce('run')
    expect(await resolveSelection({ variants: [] })).toMatchObject({ product: 'app', target: 'dev' })
    expect(select).toHaveBeenCalledTimes(2)
    vi.mocked(select).mockClear()
    expect(await resolveSelection({ command: 'dev', variants: [] })).toMatchObject({ product: 'app' })
    expect(select).not.toHaveBeenCalled()
  })

  it('never prompts in a pipe or CI and rejects ambiguous or invalid selections', async () => {
    terminal(false)
    await expect(resolveSelection({ command: 'dev', variants: [] })).rejects.toThrow('Product is required')
    await expect(resolveSelection({ product: 'app', variants: [] })).rejects.toThrow('Target is required')
    terminal(true)
    for (const value of ['true', '1', 'vendor', ' TRUE ']) {
      vi.stubEnv('CI', value)
      await expect(resolveSelection({ command: 'dev', variants: [] })).rejects.toThrow('Product is required')
    }
    await expect(resolveSelection({ command: 'dev', product: 'missing', variants: [] })).rejects.toThrow('Unknown product')
    await expect(resolveSelection({ command: 'dev', product: 'app', variants: ['missing'] })).rejects.toThrow('Unknown variant')
    expect(select).not.toHaveBeenCalled()
    expect(terminalOutput).toEqual([])
  })

  it('allows prompts and the temporary screen when CI is explicitly false', async () => {
    for (const value of [undefined, '', 'false', '0', ' FaLsE ']) {
      vi.stubEnv('CI', value)
      terminalOutput = []
      vi.mocked(select).mockResolvedValueOnce('app').mockResolvedValueOnce('run')
      expect(await resolveSelection({ command: 'dev', variants: [] })).toMatchObject({ product: 'app' })
      expect(terminalOutput.join('')).toContain('\u001B[?1049h')
      expect(terminalOutput.join('')).toContain('\u001B[?1049l')
    }
  })

  it('replays targets named after builtin commands through the actual CLI dispatcher', async () => {
    const targets = ['help', 'plan', 'doctor', 'prepare']
    const marker = await executableTargets(targets)
    for (const target of targets) {
      const selection = await resolveSelection({ product: 'app', target, variants: [] })
      const command = selectionCommand(selection!)
      expect(command).toBe(`matrix -p app -t ${target} -e development`)
      await runCli(command.split(' ').slice(1))
    }
    expect(await readFile(marker, 'utf8')).toBe(`${targets.join('\n')}\n`)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runCli(['plan', 'app', '-t', 'prepare'])
    expect(JSON.parse(String(log.mock.calls[0]![0])).tasks[0].target).toBe('prepare')
    expect(await readFile(marker, 'utf8')).toBe(`${targets.join('\n')}\n`)
    expect(select).not.toHaveBeenCalled()
  })

  it('cancels without executing a task', async () => {
    const marker = await executableTargets(['build', 'test'])
    vi.mocked(outro).mockImplementation(() => {
      terminalOutput.push('Cancelled')
    })
    vi.mocked(select).mockResolvedValueOnce(CANCEL_SYMBOL)
    await runCli([])
    expect(process.exitCode).toBe(130)
    expect(select).toHaveBeenCalledTimes(1)
    const output = terminalOutput.join('')
    expect(output).toContain('\u001B[?1049l')
    expect(output.indexOf('Cancelled')).toBeGreaterThan(output.indexOf('\u001B[?1049l'))
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores the original screen and signal handlers when a prompt fails', async () => {
    const listeners = process.listenerCount('SIGTERM')
    vi.mocked(select).mockRejectedValueOnce(new Error('terminal disconnected'))
    await expect(resolveSelection({ variants: [] })).rejects.toThrow('terminal disconnected')
    expect(terminalOutput.join('')).toContain('\u001B[?1049l')
    expect(process.listenerCount('SIGTERM')).toBe(listeners)
    expect(outro).not.toHaveBeenCalled()
  })

  it('cancels an active prompt on SIGTERM and restores the terminal', async () => {
    const listeners = process.listenerCount('SIGTERM')
    vi.mocked(select).mockImplementationOnce(async (options) => {
      process.emit('SIGTERM')
      expect(options.signal!.aborted).toBe(true)
      return CANCEL_SYMBOL
    })
    expect(await resolveSelection({ variants: [] })).toBeNull()
    expect(process.exitCode).toBe(143)
    expect(terminalOutput.join('')).toContain('\u001B[?1049l')
    expect(process.listenerCount('SIGTERM')).toBe(listeners)
  })

  it.each([
    ['reload', 'SIGINT', 130],
    ['discovery', 'SIGTERM', 143],
  ] as const)('cancels a stalled configuration %s and restores the terminal', async (phase, signal, exitCode) => {
    const listeners = process.listenerCount(signal)
    const blocked = path.join(cwd, 'block')
    const ready = path.join(cwd, 'loading')
    await rm(path.join(cwd, 'matrix.config.json'))
    await writeFile(path.join(cwd, 'matrix.config.mjs'), `
      import { existsSync, writeFileSync } from 'node:fs';
      export default async () => {
        if (existsSync(${JSON.stringify(blocked)})) {
          writeFileSync(${JSON.stringify(ready)}, 'ready');
          setInterval(() => {}, 1000);
          await new Promise(() => {});
        }
        return ${JSON.stringify(config)};
      };
    `)
    if (phase === 'discovery')
      vi.mocked(select).mockResolvedValueOnce('dev')
    vi.mocked(select).mockImplementationOnce(async () => {
      await writeFile(blocked, '')
      return phase === 'reload' ? 'build' : 'env'
    })
    const running = runCli(['-p', 'app'])
    try {
      // Wait for the real Worker to enter configuration code, not a fixed delay.
      await vi.waitFor(async () => expect(await readFile(ready, 'utf8')).toBe('ready'))
      process.emit(signal)
      await running
      expect(process.exitCode).toBe(exitCode)
      expect(terminalOutput.join('')).toContain('\u001B[?1049l')
      expect(process.listenerCount(signal)).toBe(listeners)
      expect(outro).toHaveBeenCalledWith('Cancelled')
    }
    finally {
      process.emit(signal)
      await running
    }
  })

  it.each([['ACCESSIBLE', '1'], ['TERM', 'dumb']])('keeps static output when %s=%s', async (key, value) => {
    vi.stubEnv(key, value)
    vi.mocked(select).mockResolvedValueOnce('app').mockResolvedValueOnce('run')
    expect(await resolveSelection({ command: 'dev', variants: [] })).toMatchObject({ product: 'app' })
    expect(terminalOutput).toEqual([])
    expect(note).not.toHaveBeenCalled()
  })

  it('respects Clack accessibility settings even when the environment disables accessibility', async () => {
    const original = settings.accessible
    settings.accessible = true
    try {
      vi.mocked(select).mockResolvedValueOnce('app').mockResolvedValueOnce('run')
      await resolveSelection({ command: 'dev', variants: [] })
      expect(terminalOutput).toEqual([])
    }
    finally {
      settings.accessible = original
    }
  })

  it('prints final declared environment values without unrelated inherited variables', async () => {
    terminal(false)
    vi.stubEnv('PLAN_SHELL_ONLY', 'unrelated-shell-value')
    vi.stubEnv('PLAN_DOTENV_OVERRIDE', 'shell-wins')
    vi.stubEnv('VITE_PASSCODE', 'shell-passcode')
    await writeFile(path.join(cwd, '.env'), 'PLAN_DOTENV_ONLY=base\nPLAN_DOTENV_OVERRIDE=file-value\n')
    await writeFile(path.join(cwd, '.env.local'), 'PLAN_DOTENV_ONLY=local\n')
    await writeFile(path.join(cwd, '.env.production'), 'PLAN_DOTENV_ONLY=production\n')
    await writeFile(path.join(cwd, '.env.production.local'), 'PLAN_DOTENV_ONLY=production-local\n')
    await writeFile(path.join(cwd, '.env.development'), 'PLAN_INACTIVE_ONLY=development\n')
    await writeFile(path.join(cwd, 'matrix.config.json'), JSON.stringify({
      ...config,
      products: {
        app: { ...config.products.app, $env: { production: { env: { PRODUCT_TOKEN: 'product-token-value' } } } },
        other: { ...config.products.other, env: { OTHER_PRODUCT_ONLY: 'other-product-value' } },
      },
    }))
    const selection = await resolveSelection({ command: 'build', product: 'app', variants: [] })
    expect(selection!.plan.tasks[0]!.env.PLAN_SHELL_ONLY).toBe('unrelated-shell-value')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runCli(['plan', 'app', '--target', 'build'])
    const output = String(log.mock.calls[0]![0])
    const plan = JSON.parse(output)
    for (const task of plan.tasks) {
      expect(task.env).toMatchObject({
        VITE_PASSCODE: 'shell-passcode',
        PRODUCT_TOKEN: 'product-token-value',
        PLAN_DOTENV_ONLY: 'production-local',
        PLAN_DOTENV_OVERRIDE: 'shell-wins',
        MATRIX_PRODUCT_KEY: 'app',
        MATRIX_ENV_NAME: 'production',
        NODE_ENV: 'production',
      })
      expect(task.env).not.toHaveProperty('PLAN_SHELL_ONLY')
      expect(task.env).not.toHaveProperty('PLAN_INACTIVE_ONLY')
      expect(task.env).not.toHaveProperty('OTHER_PRODUCT_ONLY')
      expect(task).not.toHaveProperty('envKeys')
    }
    expect(select).not.toHaveBeenCalled()
  })

  it('restores the normal terminal before printing an interactively selected plan', async () => {
    vi.mocked(select).mockResolvedValueOnce('app').mockResolvedValueOnce('build').mockResolvedValueOnce('run')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {
      expect(terminalOutput.join('')).toContain('\u001B[?1049l')
    })
    await runCli(['plan'])
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(log.mock.calls[0]![0])).tasks.map((task: { id: string }) => task.id))
      .toEqual(['app:web:build', 'app:desktop:build'])
    expect(note).not.toHaveBeenCalled()
  })
})
