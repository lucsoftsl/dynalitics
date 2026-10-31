import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/theme-boot.js'] },
  js.configs.recommended,
  {
    files: ['packages/*/src/**/*.{ts,tsx}', 'packages/*/test/**/*.{ts,tsx}', 'scripts/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.typecheck.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Security: no dynamic code execution anywhere in the shipped packages.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': 'warn',
    },
  },
  {
    // dev scripts run in Node
    files: ['packages/*/scripts/**/*.mjs', 'scripts/**/*.mjs', 'docs/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        document: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    files: ['*.js', '*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { 'no-undef': 'off' }, // root config files run in Node; TypeScript already checks names
  },
);
