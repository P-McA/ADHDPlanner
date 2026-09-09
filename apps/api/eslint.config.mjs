import nest from '@adhd/eslint-config/nest';

export default [
  { ignores: ['dist/**'] },
  ...nest,
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    /*
     * The one file the project service cannot place: it is excluded from
     * tsconfig.json on purpose (see the note there and in
     * tsconfig.mobile-spec.json) because it imports apps/mobile across the
     * package boundary. Point the parser at the config that does own it, so
     * the type-aware rules keep running on it rather than being quietly
     * skipped.
     */
    files: ['test/mobile-client.e2e-spec.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.mobile-spec.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
