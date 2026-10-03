import { execFileSync } from 'node:child_process'
import { realpathSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import path from 'pathe'
import webpack from 'webpack'

async function verifyPackagedWebpack(directory) {
  const root = realpathSync(directory)
  const { default: matrix } = await import(pathToFileURL(path.join(root, 'node_modules/@xova/matrix/dist/webpack.js')).href)
  writeFileSync(path.join(root, 'webpack-entry.js'), [
    'import { matrix } from "virtual:matrix/runtime";',
    'export default matrix.product.name;',
  ].join('\n'))
  const compiler = webpack({
    mode: 'production',
    context: root,
    entry: './webpack-entry.js',
    target: 'node',
    output: { path: path.join(root, 'webpack-out'), filename: 'entry.js', library: { type: 'commonjs2' } },
    plugins: [matrix({ types: false })],
  })
  await new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError || stats?.hasErrors())
          reject(error ?? closeError ?? new Error(stats.toString({ all: false, errors: true })))
        else resolve()
      })
    })
  })
  const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./webpack-out/entry.js").default))'], { cwd: root, encoding: 'utf8' })
  if (JSON.parse(output) !== (process.env.MATRIX_PRODUCT_NAME ?? ''))
    throw new Error('Packaged Webpack loader returned an incorrect snapshot')
}

await verifyPackagedWebpack(process.argv[2])
