import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.pnpm-store/**', 'output/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['scripts/browser-checks/*.js'],
    languageOptions: { globals: globals.browser },
    // Playwright CLI --filename consumes a single function expression, not a module.
    rules: { '@typescript-eslint/no-unused-expressions': 'off' },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/*.mjs', 'apps/api/**/*.ts', 'apps/web/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
);
