import nextPlugin from 'eslint-config-next';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import base from './base.js';

/**
 * Flat config for the Next.js app (apps/web).
 *
 * Order matters. eslint-config-next installs `eslint-config-next/parser` for
 * every file it matches, which overrides typescript-eslint's parser and drops
 * the type information base.js's type-aware rules depend on. So we spread it
 * first, then re-assert the typescript-eslint parser for TS sources afterwards.
 */
export default tseslint.config(
  ...base,
  ...nextPlugin,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true },
    },
  },
  {
    // Config files (next.config.mjs, jest.config.mjs, eslint.config.mjs) sit
    // outside any tsconfig, so type-aware rules cannot run on them.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
