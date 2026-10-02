import { vi } from 'vitest'
import { MATRIX_ENV_SCHEMA_KEY, serializeEnvSchema } from '../../src/env-schema.js'
import { createMatrixRuntime } from '../../src/unplugin.js'

export const runtimeId = 'virtual:matrix/runtime'
export const runtimeEnv = {
  NODE_ENV: 'production',
  MATRIX_NODE_ENV: 'production',
  MATRIX_PRODUCT_NAME: 'fixture-product',
  VITE_ENABLED: 'false',
  VITE_LIMIT: '3',
  VITE_ZERO: '-0',
  PRIVATE_SECRET: 'PRIVATE_SENTINEL',
  MAIN_VITE_ONLY: 'MAIN_SENTINEL',
  PRELOAD_VITE_ONLY: 'PRELOAD_SENTINEL',
  [MATRIX_ENV_SCHEMA_KEY]: serializeEnvSchema({
    VITE_ENABLED: { type: 'boolean' },
    VITE_LIMIT: { type: 'number' },
    VITE_ZERO: { type: 'number' },
    VITE_MISSING: { type: 'string', optional: true },
  }),
}

export function stubRuntimeEnv(): void {
  for (const [key, value] of Object.entries(runtimeEnv))
    vi.stubEnv(key, value)
}

export const runtimeSnapshot = createMatrixRuntime(runtimeEnv)

// Independent reference module: no production serializer or transform. Keep -0,
// absent optional fields and all three frozen objects observable to the corpus.
export const referenceRuntime = `
export const matrix = Object.freeze({
  environment: '', target: '', nodeEnv: 'production', isProduction: true,
  isDevelopment: false, isTest: false, variant: '', project: '',
  product: Object.freeze({ key: '', id: '', name: 'fixture-product', slug: '' }),
  config: Object.freeze({ enabled: false, limit: 3, zero: -0 }),
});
`

export interface RuntimeFixture {
  name: string
  source: string
  extension?: 'js' | 'jsx' | 'ts' | 'tsx' | 'mts' | 'cts'
  files?: Record<string, string>
}

export interface ReadCase extends RuntimeFixture {
  value: unknown
  events?: unknown[]
  error?: string
  dce?: boolean
}

const prelude = `import { matrix } from '${runtimeId}';`

export const staticReadCase: ReadCase = {
  name: 'renamed imports and static string keys',
  source: `import { matrix as context } from '${runtimeId}';
      if (context.isDevelopment || context.config.enabled) import('./dev-only.js');
      globalThis.result = [context['isProduction'], context.config.limit, context.product.name];`,
  value: [true, 3, 'fixture-product'],
  dce: true,
}

export const readCases: ReadCase[] = [
  staticReadCase,
  {
    name: 'dynamic reads, aliases, destructuring and frozen scalar values',
    source: `${prelude}
      const alias = matrix;
      const config = matrix.config;
      const { limit } = config;
      globalThis.result = {
        dynamic: alias[globalThis.key], limit,
        unchanged: [Reflect.set(alias, 'isDevelopment', true), Reflect.set(config, 'enabled', true), Reflect.set(matrix.product, 'name', 'changed')],
        flags: [matrix.isDevelopment, alias.isDevelopment, config.enabled],
        zero: [matrix.config.zero, config.zero],
        missing: [matrix.config.missing, Object.hasOwn(config, 'missing')],
        frozen: [Object.isFrozen(alias), Object.isFrozen(config), Object.isFrozen(matrix.product)],
      };`,
    value: {
      dynamic: true,
      limit: 3,
      unchanged: [false, false, false],
      flags: [false, false, false],
      zero: [-0, -0],
      missing: [undefined, false],
      frozen: [true, true, true],
    },
  },
  {
    name: 'parameter and lexical shadowing with hoisted closure references',
    source: `${prelude}
      function shadow(matrix) { return matrix.isProduction; }
      function local() { const get = () => matrix.isProduction; const matrix = { isProduction: false }; return get(); }
      globalThis.result = [shadow({ isProduction: false }), local(), matrix.isProduction];`,
    value: [false, false, true],
  },
  {
    name: 'default parameters use the outer import, not a body var',
    source: `${prelude}
      function read(value = matrix.isProduction) { var matrix = { isProduction: false }; return [value, matrix.isProduction]; }
      globalThis.result = read();`,
    value: [true, false],
  },
  {
    name: 'catch, loop and named class bindings stay local',
    source: `${prelude}
      const values = [];
      try { throw { isProduction: false }; } catch (matrix) { values.push(matrix.isProduction); }
      for (const matrix of [{ isProduction: false }]) values.push(matrix.isProduction);
      const Local = class matrix { static isProduction = false; static read() { return matrix.isProduction; } };
      globalThis.result = [...values, Local.read(), matrix.isProduction];`,
    value: [false, false, false, true],
  },
  {
    name: 'an unrelated module with the same export is not Matrix',
    source: `import { matrix } from './other.js'; matrix.isProduction++; globalThis.result = matrix.isProduction;`,
    files: { 'other.js': 'export const matrix = { isProduction: 7 };' },
    value: 8,
  },
  {
    name: 'namespace imports and reexports use the frozen runtime',
    source: `import * as namespace from '${runtimeId}'; import { matrix as reexported } from './bridge.js';
      globalThis.result = [namespace.matrix === reexported, Object.isFrozen(reexported), reexported.isProduction];`,
    files: { 'bridge.js': `export { matrix } from '${runtimeId}';` },
    value: [true, true, true],
  },
  {
    name: 'dynamic keys keep effects and missing or inherited properties stay reads',
    source: `${prelude}
      const key = () => { globalThis.events.push('key'); return 'enabled'; };
      globalThis.result = [matrix.config[key()], matrix.config.unknown, matrix.config?.enabled,
        matrix.product.name.length, typeof matrix.config.toString];`,
    value: [false, undefined, false, 'fixture-product'.length, 'function'],
    events: ['key'],
  },
  {
    name: 'short circuit, comma and conditional values are not delete references',
    source: `${prelude}
      const effect = () => { globalThis.events.push('effect'); return true; };
      globalThis.result = [matrix.isDevelopment && effect(), matrix.isProduction || effect(),
        delete (effect(), matrix.isProduction), delete (true ? matrix.isProduction : matrix.isDevelopment)];`,
    value: [false, true, true, true],
    events: ['effect'],
  },
  {
    name: 'indirect mutation throws without changing snapshot state',
    source: `${prelude}
      const alias = matrix.config;
      globalThis.events.push(matrix.config.enabled);
      alias.enabled = true;
      globalThis.events.push('unreachable');`,
    value: undefined,
    events: [false],
    error: 'TypeError',
  },
  {
    name: 'cross-module mutation cannot change statically optimized reads',
    source: `import './writer.js'; ${prelude}
      if (matrix.isDevelopment) import('./dev-only.js');
      globalThis.result = [matrix.isDevelopment, globalThis.changed];`,
    files: { 'writer.js': `${prelude} globalThis.changed = Reflect.set(matrix, 'isDevelopment', true);` },
    value: [false, false],
    dce: true,
  },
  {
    name: 'real dynamic imports execute their chunks and preserve effects',
    source: `${prelude}
      globalThis.result = matrix.isProduction ? import('./lazy.js').then(module => module.value) : null;`,
    files: { 'lazy.js': `${prelude} globalThis.events.push('lazy'); export const value = matrix.config.limit;` },
    value: 3,
    events: ['lazy'],
  },
  {
    name: 'TypeScript assertions and generic arrow functions',
    extension: 'ts',
    source: `${prelude}
      const value = <number>matrix.config.limit;
      const identity = <T>(value: T): T => value;
      if (matrix.isDevelopment satisfies boolean) import('./dev-only.js');
      globalThis.result = identity(value);`,
    value: 3,
    dce: true,
  },
  ...(['jsx', 'tsx'] as const).map(extension => ({
    name: `JSX values in .${extension} modules`,
    extension,
    source: `${prelude}
      const React = { createElement(tag, props, child) { return [tag, child]; } };
      const label${extension === 'tsx' ? ': string' : ''} = matrix.product.name;
      if (matrix.isDevelopment) import('./dev-only.js');
      globalThis.result = <div>{label}</div>;`,
    value: ['div', 'fixture-product'],
    dce: true,
  })),
  ...(['mts', 'cts'] as const).map(extension => ({
    name: `.${extension} entry modules`,
    extension,
    source: `${prelude} const value: number = matrix.config.limit;
      if (matrix.isDevelopment) import('./dev-only.js'); globalThis.result = value;`,
    value: 3,
    dce: true,
  })),
]

export const writeCases: RuntimeFixture[] = [
  ['assignment', 'matrix.config.enabled = true'],
  ['compound assignment', 'matrix.config.limit += 1'],
  ['update', 'matrix.config.limit++'],
  ['delete', 'delete matrix.product.name'],
  ['optional delete', 'delete matrix?.isProduction'],
  ['dynamic target', 'matrix.config[globalThis.key] = true'],
  ['object destructuring', '({ value: matrix.config.enabled } = { value: true })'],
  ['array destructuring', '[matrix.config.enabled] = [true]'],
  ['iteration target', 'for (matrix.config.enabled of [true]) {}'],
].map(([name, statement]) => ({ name: name!, source: `${prelude} ${statement}` }))

writeCases.push({
  name: 'nested TypeScript delete regression',
  extension: 'ts',
  source: `${prelude}
    globalThis.result = delete ((<boolean>((matrix.isProduction<boolean>) satisfies boolean) as boolean)!);`,
})

// Deterministic, bounded syntax generation. These source-level forms are not
// derived from the transform's AST switch. Adjacent pairs exercise depth two
// without an unbounded Cartesian product of all possible programs.
// Scalar instantiation intentionally covers transpile-only input: a type error
// must not let the optimizer silently change the runtime meaning of deletion.
const wrappers = [
  { name: 'parentheses', wrap: (value: string, _type: string) => `(${value})` },
  { name: 'as', wrap: (value: string, type: string) => `(${value} as ${type})` },
  { name: 'assertion', wrap: (value: string, type: string) => `(<${type}>${value})` },
  { name: 'non-null', wrap: (value: string, _type: string) => `(${value})!` },
  { name: 'satisfies', wrap: (value: string, type: string) => `(${value} satisfies ${type})` },
  { name: 'instantiation', wrap: (value: string, type: string) => `(${value})<${type}>` },
]
for (const [index, wrapper] of wrappers.entries()) {
  const inner = wrappers[(index + 1) % wrappers.length]!
  for (const nested of [false, true]) {
    const label = nested ? `${wrapper.name}/${inner.name}` : wrapper.name
    const wrap = (value: string, type: string): string => wrapper.wrap(nested ? inner.wrap(value, type) : value, type)
    readCases.push({
      name: `wrapped flags and computed write keys: ${label}`,
      extension: 'ts',
      source: `${prelude}
        if (${wrap('matrix.isDevelopment', 'boolean')}) import('./dev-only.js');
        const target = {};
        target[${wrap('matrix.product.name', 'string')}] = matrix.config.limit;
        const removed = delete target[${wrap('matrix.product.name', 'string')}];
        globalThis.result = [removed, Object.keys(target).length];`,
      value: [true, 0],
      dce: true,
    })
    writeCases.push({
      name: `wrapped delete target: ${label}`,
      extension: 'ts',
      source: `${prelude} globalThis.result = delete (${wrap('matrix.isProduction', 'boolean')});`,
    })
  }
}
