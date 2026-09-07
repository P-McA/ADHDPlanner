import nest from '@adhd/eslint-config/nest';

export default [
  { ignores: ['dist/**'] },
  ...nest,
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
];
