import type { Configuration } from 'webpack'
import webpack from 'webpack'

export async function compileWebpack(options: Configuration): Promise<void> {
  const compiler = webpack(options)
  await new Promise<void>((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError)
          reject(error ?? closeError)
        else if (stats?.hasErrors())
          reject(new Error(stats.toString({ all: false, errors: true })))
        else resolve()
      })
    })
  })
}
