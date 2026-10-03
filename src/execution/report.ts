import type { ExecutionPlan } from '../types.js'
import consola from 'consola'

export interface FailureContext {
  id: string
  phase: 'preparation' | 'command' | 'readiness' | 'artifact handling' | 'cleanup'
  project?: string
  affectedTask?: string
  step?: number
  steps?: number
}

type Outcome = 'not run' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stopped'

interface ReportEntry {
  id: string
  continuous: boolean
  outcome: Outcome
}

/** Internal execution diagnostics; never added to the serialized plan. */
export class ExecutionFailure extends Error {
  constructor(message: string, readonly context: FailureContext, cause: unknown) {
    super(message, { cause })
  }
}

/** One invocation, including cleanup and explicit prepare's type generation. */
export class ExecutionReport {
  private readonly startedAt = performance.now()
  private readonly entries = new Map<string, ReportEntry>()
  private readonly failures: string[] = []
  private readonly artifacts = new Set<string>()
  private printed = false
  private signal: false | 'SIGINT' | 'SIGTERM' = false

  constructor(plan: ExecutionPlan) {
    const units = [...plan.preparations ?? [], ...plan.tasks]
    for (const unit of units) {
      this.entries.set(unit.id, { id: unit.id, continuous: 'continuous' in unit && unit.continuous, outcome: 'not run' })
    }
  }

  private singleLine(message: string): string {
    // Keep arbitrary error text from adding terminal controls or fake summary rows.
    return message.replace(/\p{Cc}/gu, ' ')
  }

  start(id: string): void {
    const entry = this.entries.get(id)
    if (entry)
      entry.outcome = 'running'
  }

  complete(id: string): void {
    const entry = this.entries.get(id)
    if (entry && entry.outcome === 'running')
      entry.outcome = entry.continuous ? 'stopped' : 'completed'
  }

  cancel(signal: 'SIGINT' | 'SIGTERM'): void {
    this.signal = signal
  }

  artifact(path: string): void {
    this.artifacts.add(path)
  }

  fail(context: FailureContext, error: unknown): ExecutionFailure {
    if (error instanceof ExecutionFailure)
      return error
    const entry = this.entries.get(context.id)
    if (entry)
      entry.outcome = 'failed'
    const details = [
      context.phase,
      ...(context.project ? [`project ${context.project}`] : []),
      ...(context.affectedTask ? [`affected task ${context.affectedTask}`] : []),
      ...(context.step !== undefined ? [`step ${context.step}/${context.steps}`] : []),
    ]
    const code = error instanceof Error && 'code' in error ? String(error.code) : undefined
    // Process errors can contain the full command in message/shortMessage.
    const reason = error instanceof Error && 'command' in error
      ? `Unable to execute command${code ? ` (${code})` : ''}`
      : error instanceof Error ? `${error.message}${code ? ` (${code})` : ''}` : 'Unknown execution error'
    const message = this.singleLine(`${context.id} [${details.join(', ')}]: ${reason}`)
    this.failures.push(message)
    return new ExecutionFailure(message, context, error)
  }

  print(): void {
    if (this.printed)
      return
    this.printed = true
    const outcome = this.failures.length ? 'failed' : this.signal ? 'cancelled' : 'succeeded'
    const lines = [`Execution ${outcome}${this.signal ? ` (${this.signal})` : ''} — ${((performance.now() - this.startedAt) / 1000).toFixed(2)}s`]
    for (const entry of this.entries.values()) {
      const status = entry.outcome === 'running'
        ? this.signal && !entry.continuous ? 'cancelled' : 'stopped'
        : entry.outcome
      lines.push(`  ${entry.id}: ${status}`)
    }
    for (const failure of this.failures)
      lines.push(`  Failure: ${failure}`)
    for (const artifact of this.artifacts)
      lines.push(`  Artifact: ${artifact}`)
    consola.info(lines.map(line => this.singleLine(line)).join('\n'))
  }
}
