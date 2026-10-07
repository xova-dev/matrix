import type { Plugin } from 'vite'
import type { MatrixUnpluginOptions } from './options.js'
import { MatrixUnplugin } from './index.js'

// Keep other hosts' optional types out of the consumer's Vite declaration graph.
export default function matrix(options?: MatrixUnpluginOptions): Plugin | Plugin[] {
  return MatrixUnplugin.vite(options)
}
