import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = Object.fromEntries(
  [
    'process',
    'console',
    'Buffer',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'URL',
    'URLSearchParams',
    'fetch',
    'AbortSignal',
    'TextDecoder',
    'structuredClone',
  ].map((g) => [g, 'readonly']),
);
const browserGlobals = Object.fromEntries(
  [
    'window',
    'document',
    'navigator',
    'localStorage',
    'location',
    'history',
    'fetch',
    'caches',
    'self',
    'URL',
    'console',
  ].map((g) => [g, 'readonly']),
);

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'data/**', 'var/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.mjs', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: nodeGlobals },
  },
  { files: ['web/**/*.js'], languageOptions: { globals: browserGlobals, sourceType: 'script' } },
);
