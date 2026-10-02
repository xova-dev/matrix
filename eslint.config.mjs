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
    ],
  },
  {
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Keep framework versions independent from the core integration-test toolchain.
    files: ['examples/electron-web/package.json'],
    rules: { 'pnpm/json-enforce-catalog': 'off' },
  },
)
