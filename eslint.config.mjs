import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', '**/playwright-report/**', '**/test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // segredos e tokens nunca devem cair em console.log fora do logger
      'no-restricted-globals': ['error', { name: 'event', message: 'use o parametro do handler' }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // o logger compartilhado e o unico lugar que fala com o console
    files: ['**/*.{ts,tsx}'],
    ignores: ['packages/shared/src/logger.ts', 'scripts/**'],
    rules: {
      'no-console': ['warn', { allow: ['error'] }],
    },
  },
);
