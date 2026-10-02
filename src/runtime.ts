/** Immutable snapshot for one build context, not application state. */
export interface MatrixRuntime<Config extends object = Record<string, string | number | boolean | undefined>> {
  readonly environment: string
  readonly target: string
  readonly nodeEnv: 'development' | 'production' | 'test' | string
  readonly isDevelopment: boolean
  readonly isProduction: boolean
  readonly isTest: boolean
  readonly variant: string
  readonly project: string
  readonly product: {
    readonly key: string
    readonly id: string
    readonly name: string
    readonly slug: string
    readonly appId?: string
    readonly version?: string
  }
  readonly config: Readonly<Config>
}
