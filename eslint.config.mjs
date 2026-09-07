import base from '@adhd/eslint-config/base';

/**
 * Root config: workspace-wide ignores plus linting for repo-level files.
 * Apps and packages each have their own eslint.config.mjs.
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      'apps/**',
      'packages/**',
      '.idea/**',
    ],
  },
  ...base,
  {
    files: ['*.{js,mjs,cjs}'],
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
];
