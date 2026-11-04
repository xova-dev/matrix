// Runner budgets include fixture startup and teardown, not product deadlines.
// Keep readiness/cancellation durations under test at their call sites.
export const processTestTimeout = 60_000
export const workflowTestTimeout = 120_000
export const cleanupTimeout = 60_000
export const fixtureReadyTimeout = 30_000
