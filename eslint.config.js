import tseslint from 'typescript-eslint'
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      '**/dist/**',
      'graphify-out/**',
      'test-results/**',
      'playwright-report/**',
      'tests/fixtures/**'
    ]
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  }
)
