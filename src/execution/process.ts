import path from 'node:path'
import process from 'node:process'
import { execa } from 'execa'
import { settleAll } from '../utils/errors.js'
import { stopProcessGroups } from './process-tree.js'
import { quoteWindowsArgument, startWindowsJob } from './windows-job.js'

export interface ProcessResult {
  exitCode?: number | undefined
  signal?: string | undefined
  code?: string | undefined
}

/** Root completion is distinct from release of every owned process and handle. */
export interface OwnedProcess<T = ProcessResult> {
  result: Promise<T>
  dispose: () => Promise<void>
}

type ProcessInput = { command: string } | { file: string, args: string[] }

export function startProcess(input: ProcessInput, cwd: string, env: Record<string, string | undefined>, stdin: 'inherit' | 'ignore' = 'inherit'): OwnedProcess {
  if (process.platform === 'win32') {
    // cmd parses forward slashes in its own command line as switches, even
    // inside argv[0]. Keep the executable spelling native to this backend.
    const shell = path.win32.join(process.env.SystemRoot ?? process.env.windir ?? '', 'System32', 'cmd.exe')
    return 'command' in input
      ? startWindowsJob(shell, `${quoteWindowsArgument(shell)} /d /s /c "${input.command}"`, cwd, env, stdin)
      : startWindowsJob(input.file, [input.file, ...input.args].map(quoteWindowsArgument).join(' '), cwd, env, stdin)
  }
  const options = {
    cwd,
    env,
    extendEnv: false,
    forceKillAfterDelay: false as const,
    stdin,
    stdout: 'inherit' as const,
    stderr: 'inherit' as const,
    reject: false as const,
    killDescendants: true,
    // Session owns teardown; Execa must not race it with an exit cleanup.
    cleanup: false,
  }
  const child = 'command' in input
    ? execa(input.command, { ...options, shell: true })
    : execa(input.file, input.args, options)
  let disposal: Promise<void> | undefined
  return {
    result: child,
    dispose: () => disposal ??= stopProcessGroups([child]),
  }
}

/** A failed disposal never permits early release of another in-flight owner. */
export async function disposeProcesses(children: OwnedProcess<unknown>[]): Promise<void> {
  await settleAll(children.map(child => () => child.dispose()))
}
