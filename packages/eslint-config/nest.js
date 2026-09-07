import globals from 'globals';
import tseslint from 'typescript-eslint';

import base from './base.js';

/** Flat config for NestJS services (apps/api). */
export default tseslint.config(...base, {
  languageOptions: {
    globals: { ...globals.node },
  },
  rules: {
    // Nest modules are intentionally empty classes carrying only decorators.
    '@typescript-eslint/no-extraneous-class': 'off',
    // Decorator metadata means parameter properties are the idiomatic DI style.
    '@typescript-eslint/parameter-properties': 'off',
  },
});
