import base from '@adhd/eslint-config/base';

/**
 * `tsconfigRootDir` is set here, not in the shared config: projectService
 * resolves tsconfigs relative to it, so it has to point at this package.
 * Mirrors apps/web.
 */
const config = [
  { ignores: ['.expo/**', 'android/**', 'ios/**'] },
  ...base,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // Jest's config and the stub it maps to are loaded by Jest itself, through
    // `require`, before any bundler is involved — they are CommonJS and cannot
    // be anything else. The rest of the package is ESM, so this is scoped to
    // the two files rather than relaxed globally.
    files: ['jest.config.js', 'test/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
];

export default config;
