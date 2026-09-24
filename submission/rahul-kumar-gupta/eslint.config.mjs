import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'coverage/**', 'dist/**', '*.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Test specs must go through the framework layers, never straight to SQL or HTTP.
    files: ['tests/specs/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'better-sqlite3', message: 'Specs read persistence through repositories / verifiers only.' },
            { name: 'supertest', message: 'Specs talk HTTP through SubscriptionApiClient / WebhookSimulator only.' },
          ],
        },
      ],
    },
  },
);
