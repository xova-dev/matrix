import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'lib',
    typescript: true,
    formatters: {
      markdown: 'prettier',
    },
    ignores: [
      'dist/**',
      'artifacts/**',
      '.matrix/**',
      'coverage/**',
      'examples/**/dist/**',
      'examples/**/release/**',
      'examples/**/artifacts/**',
      'examples/**/.matrix/**',
      'examples/**/.prepared/**',
      'examples/**/.matrix-acceptance-*/**',
      'examples/electron-web/package-lock.json',
    ],
  },
  {
    rules: {
      'no-console': 'off',
    },
  },
  {
    // An independently installed consumer: npm cannot resolve the repository's catalog.
    files: ['examples/electron-web/package.json'],
    rules: { 'pnpm/json-enforce-catalog': 'off' },
  },
)
