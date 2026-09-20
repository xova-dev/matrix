/** Default values applied when a Matrix configuration omits optional fields. */
export const MATRIX_DEFAULTS = {
  target: 'dev',
  environment: 'development',
  projectRoot: '.',
  outputDir: 'dist',
  artifactsRoot: 'artifacts',
  archive: { enabled: false, format: 'zip' },
  targets: {
    dev: { environment: 'development', nodeEnv: 'development', continuous: true },
    build: { environment: 'production', nodeEnv: 'production', continuous: false },
    preview: { environment: 'production', nodeEnv: 'production', continuous: true },
  },
} as const

/** Returns the default environment associated with a target name. */
export function defaultEnvironmentForTarget(target: string): string {
  return MATRIX_DEFAULTS.targets[target as keyof typeof MATRIX_DEFAULTS.targets]?.environment ?? MATRIX_DEFAULTS.environment
}
