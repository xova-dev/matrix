export interface MatrixRuntime<Config extends object = Record<string, string>> {
  environment: string
  target: string
  nodeEnv: 'development' | 'production' | 'test' | string
  isDevelopment: boolean
  isProduction: boolean
  isTest: boolean
  variant: string
  project: string
  product: {
    key: string
    id: string
    name: string
    slug: string
    appId?: string
  }
  config: Config
}
