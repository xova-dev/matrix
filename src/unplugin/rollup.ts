import type { Plugin } from 'rollup'
import type { MatrixUnpluginOptions } from './options.js'
import { MatrixUnplugin } from './index.js'

// Expose the consumer's host type without pulling in Unplugin's optional hosts.
export default function matrix(options?: MatrixUnpluginOptions): Plugin {
  return MatrixUnplugin.rollup(options)
}
