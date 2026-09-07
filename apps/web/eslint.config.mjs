import next from '@adhd/eslint-config/next';

/**
 * `tsconfigRootDir` is set here, not in the shared config: projectService
 * resolves tsconfigs relative to it, so it has to point at this package.
 * Scoped to TS files so it never re-applies parser options to the plain-JS
 * config files that the shared config deliberately excludes from type-aware
 * linting.
 */
const config = [
  { ignores: ['.next/**', 'next-env.d.ts'] },
  ...next,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
];

export default config;
