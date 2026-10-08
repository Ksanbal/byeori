import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { plugin as shadcn } from '@shadcn/lint';

export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**', '.inputs/**', '.delivery/**', '.byeori/**']),
  { files: ['**/*.{js,mjs,ts,tsx}'], extends: [js.configs.recommended], languageOptions: { globals: globals.node } },
  { files: ['**/*.{ts,tsx}'], extends: [tseslint.configs.recommended] },
  {
    files: ['src/studio/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    plugins: { shadcn },
    settings: { shadcn: { ui: '@/components/ui' } },
    rules: {
      'shadcn/no-restyle': ['error', { allow: ['layout'] }],
      'shadcn/no-raw-colors': 'error',
      'shadcn/no-arbitrary-values': 'error',
      'shadcn/no-inline-styles': 'error',
      'shadcn/no-unknown-classes': 'error',
      'shadcn/require-static-classes': 'error',
    },
  },
  { files: ['src/studio/components/ui/**/*.{ts,tsx}'], rules: { 'shadcn/no-restyle': 'off' } },
]);
