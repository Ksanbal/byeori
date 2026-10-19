import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default defineConfig([
  globalIgnores(['dist/**', 'plugins/byeori-claude/runtime/**', 'plugins/byeori-codex/runtime/**', 'artifacts/**', 'node_modules/**', '.inputs/**', '.delivery/**', '.byeori/**']),
  {files: ['**/*.{js,mjs,ts,tsx}'], extends: [js.configs.recommended], languageOptions: {globals: globals.node}},
  {files: ['**/*.{ts,tsx}'], extends: [tseslint.configs.recommended]},
  {files: ['src/viewer/ui/**/*.{ts,tsx}'], languageOptions: {globals: globals.browser}},
]);
