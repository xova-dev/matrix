import type { SourceMap } from 'magic-string'
import type { Comment, Node, ParserOptions } from 'oxc-parser'
import type { MatrixRuntime } from './index.js'
import MagicString from 'magic-string'
import { parseSync } from 'oxc-parser'
import { ScopeTracker, walk } from 'oxc-walker'

/** Type-only wrappers do not change the receiver's identity. */
function unwrapReceiver(node: Node): Node {
  switch (node.type) {
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSInstantiationExpression':
    case 'TSTypeAssertion':
    case 'TSNonNullExpression':
      return unwrapReceiver(node.expression)
    default:
      return node
  }
}

/** Is this expression part of a write target, rather than a computed key/read? */
function isWrite(node: Node, ancestors: Node[]): boolean {
  let child = node
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const parent = ancestors[index]!
    switch (parent.type) {
      case 'AssignmentExpression':
      case 'AssignmentPattern':
      case 'ForInStatement':
      case 'ForOfStatement':
        if (parent.left !== child)
          return false
        if (parent.type !== 'AssignmentPattern')
          return true
        break
      case 'UpdateExpression':
        return true
      case 'UnaryExpression':
        return parent.operator === 'delete'
      case 'MemberExpression':
        if (parent.object !== child)
          return false
        break
      case 'Property':
        if (parent.value !== child)
          return false
        break
      case 'ObjectPattern':
      case 'ArrayPattern':
      case 'RestElement':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSInstantiationExpression':
      case 'TSTypeAssertion':
      case 'TSNonNullExpression':
      case 'ChainExpression':
        break
      default:
        return false
    }
    child = parent
  }
  return false
}

/** Only own, present scalar leaves are constants. Missing/inherited keys stay reads. */
export function inlineMatrixReads(code: string, id: string, runtimeId: string, runtime: MatrixRuntime, lang?: ParserOptions['lang']): { code: string, map: SourceMap, comments: readonly Comment[] } | undefined {
  if (!code.includes(runtimeId))
    return
  const filename = id.split('?')[0]!
  // Parsing is a final safety check, not a substitute for the adapter's module
  // eligibility checks. Unsupported syntax stays with the host.
  const parsed = parseSync(filename, code, {
    lang: lang ?? (/\.tsx$/.test(filename) ? 'tsx' : /\.[cm]?ts$/.test(filename) ? 'ts' : 'jsx'),
    preserveParens: false,
  })
  if (parsed.errors.length)
    return
  if (!parsed.program.body.some(node => node.type === 'ImportDeclaration' && node.source.value === runtimeId))
    return

  const scopeTracker = new ScopeTracker({ preserveExitedScopes: true })
  walk(parsed.program, { scopeTracker })
  scopeTracker.freeze()
  const output = new MagicString(code)
  const ancestors: Node[] = []
  walk(parsed.program, {
    scopeTracker,
    enter(node) {
      if (node.type === 'MemberExpression') {
        const keys: Array<string | undefined> = []
        let root: Node = node
        while (root.type === 'MemberExpression') {
          keys.unshift(!root.computed && root.property.type === 'Identifier'
            ? root.property.name
            : root.computed && root.property.type === 'Literal' && typeof root.property.value === 'string'
              ? root.property.value
              : undefined)
          root = unwrapReceiver(root.object)
        }
        const binding = root.type === 'Identifier' ? scopeTracker.getDeclaration(root.name) : undefined
        if (binding?.type === 'Import'
          && binding.importNode.source.value === runtimeId
          && binding.node.type === 'ImportSpecifier'
          && (binding.node.imported.type === 'Identifier' ? binding.node.imported.name : binding.node.imported.value) === 'matrix') {
          if (isWrite(node, ancestors))
            throw new Error(`Matrix snapshot is read-only: cannot write to ${runtimeId} in ${id}`)
          let value: unknown = runtime
          for (const key of keys) {
            if (key === undefined || value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
              value = undefined
              break
            }
            value = (value as Record<string, unknown>)[key]
          }
          if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
            // Parentheses also make numeric receiver expressions syntactically safe.
            output.overwrite(node.start, node.end, `(${Object.is(value, -0) ? '-0' : JSON.stringify(value)})`)
            this.skip()
          }
        }
      }
      ancestors.push(node)
    },
    leave() {
      ancestors.pop()
    },
  })
  if (!output.hasChanged())
    return
  return { code: output.toString(), map: output.generateMap({ source: id, includeContent: true, hires: true }), comments: parsed.comments }
}
