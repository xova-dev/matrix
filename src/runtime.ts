export interface MatrixRuntime<Config extends object = Record<string, string>> {
  environment: string
  target: string
  nodeEnv: 'development' | 'production' | 'test' | string
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
