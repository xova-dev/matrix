import process from 'node:process'
import { settings } from '@clack/prompts'

export interface SelectionScreen {
  signal: AbortSignal
  page: () => void
  close: () => void
}

export function isInteractiveTerminal(): boolean {
  const ci = process.env.CI?.trim().toLowerCase() ?? ''
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && ['', 'false', '0'].includes(ci))
}

/** Owns only the temporary wizard screen; child processes run after it closes. */
export function createSelectionScreen(): SelectionScreen {
  const accessible = settings.accessible ?? (process.env.ACCESSIBLE !== undefined
    && !['', '0', 'false'].includes(process.env.ACCESSIBLE))
  const transient = Boolean(isInteractiveTerminal()
    && !accessible && process.env.TERM !== 'dumb' && process.env.TERM !== 'unknown')
  let controller = new AbortController()
  let started = false
  let alternate = false
  let previousRawMode = false

  const interrupt = (): void => {
    process.exitCode = 130
    controller.abort()
  }
  const terminate = (): void => {
    process.exitCode = 143
    controller.abort()
  }
  const close = (): void => {
    if (!started)
      return
    started = false
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
    process.removeListener('exit', close)
    if (alternate) {
      alternate = false
      process.stdout.write('\u001B[?1049l\u001B[?25h')
    }
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
      try {
        process.stdin.setRawMode(previousRawMode)
      }
      catch {
        // The terminal may have disconnected while the prompt was active.
      }
    }
  }

  return {
    get signal() { return controller.signal },
    page() {
      controller.signal.throwIfAborted()
      // Completed prompts must not stay subscribed to later cancellation events.
      controller = new AbortController()
      if (!started) {
        started = true
        previousRawMode = Boolean(process.stdin.isRaw)
        process.on('SIGINT', interrupt)
        process.on('SIGTERM', terminate)
        process.once('exit', close)
        if (transient) {
          alternate = true
          process.stdout.write('\u001B[?1049h')
        }
      }
      // Erase only the alternate screen, never the user's normal screen or scrollback.
      if (alternate)
        process.stdout.write('\u001B[2J\u001B[H')
    },
    close,
  }
}
