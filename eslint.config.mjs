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
    ],
  },
  {
    rules: {
      'no-console': 'off',
    },
  },
)
