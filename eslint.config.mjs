// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      // Vite emits the compiled browser bundle here so world-web can serve it as static files.
      // It is build output, not source.
      'apps/world-web/public/**',
      'playwright-report/**',
      'test-results/**',
      'infra/generated/**',
      'infra/.build/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']:not([parent.type='VariableDeclarator'])",
          message:
            'Read process.env only inside a validated configuration module, never in domain or feature code.',
        },
      ],
    },
  },
  // The simulation and domain packages must stay deterministic and framework free.
  {
    files: ['packages/domain/src/**/*.ts', 'packages/simulation/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Domain and simulation code must not read the environment.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Simulation randomness must come from the injected seeded PRNG.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Simulation time must come from logical ticks or an injected clock.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@azure/*', 'fastify*', 'react*', 'openai', '@babylonjs/*', 'node:*'],
              message:
                'Domain and simulation packages must remain free of infrastructure dependencies.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web-client/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['scripts/**/*.mjs', 'apps/web-client/vite.config.ts', '*.config.{ts,js,mjs}'],
    rules: { 'no-console': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
