import base from '@adhd/eslint-config/base';

export default [
  { ignores: ['dist/**'] },
  ...base,
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
];
