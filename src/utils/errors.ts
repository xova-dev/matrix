/** Preserve a single failure's identity; combine independent failures without duplicates. */
export function throwFailures(failures: unknown[]): void {
  const unique = [...new Set(failures)]
  if (!unique.length)
    return
  if (unique.length === 1)
    throw unique[0]
  const errors = [...new Set(unique.flatMap(error => error instanceof AggregateError && error.errors.length ? error.errors : [error]))]
  if (errors.length === 1)
    throw errors[0]
  throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; '), { cause: errors[0] })
}

/** Attempt every independent release and join all of them before reporting failure. */
export async function settleAll(actions: (() => unknown | Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(actions.map(async action => action()))
  throwFailures(results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
}

/** Ordered cleanup must run on success and failure without replacing the operation's error. */
export async function withCleanup<T>(action: () => T | Promise<T>, cleanup: () => unknown | Promise<unknown>): Promise<T> {
  const errors: unknown[] = []
  let value!: T
  try {
    value = await action()
  }
  catch (error) {
    errors.push(error)
  }
  try {
    await cleanup()
  }
  catch (error) {
    errors.push(error)
  }
  throwFailures(errors)
  return value
}
