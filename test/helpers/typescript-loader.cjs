const { transform } = require('esbuild')

module.exports = function (source) {
  const callback = this.async()
  transform(source, {
    loader: this.resourcePath.endsWith('.tsx') ? 'tsx' : this.resourcePath.endsWith('.jsx') ? 'jsx' : 'ts',
    format: 'esm',
    target: 'esnext',
    sourcemap: true,
    sourcefile: this.resourcePath,
  }).then(result => callback(null, result.code, JSON.parse(result.map)), callback)
}
