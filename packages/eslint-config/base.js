import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Shared flat config for every package in the workspace.
 *
 * Type-aware rules are on (`recommendedTypeChecked`), resolved via
 * `projectService` so no tsconfig path list needs maintaining. Each consuming
 * package must supply its own `tsconfigRootDir` — see apps/api/eslint.config.js.
 *
 * `prettier` goes last so it can switch off every formatting rule the configs
 * above turned on. Formatting is Prettier's job alone.
 */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Needs parser services, so it must not reach plain-JS config files.
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // Config files are plain JS and sit outside any tsconfig's include globs.
    // disableTypeChecked only silences rules from typescript-eslint's own
    // presets, so anything enabled by hand above must be scoped, not relied on.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
