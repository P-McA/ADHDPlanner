/**
 * jest-expo supplies the React Native preset: the Metro-style module
 * resolution, the native-module mocks, and the transform that turns RN's
 * untranspiled ESM into something Jest can load.
 *
 * `transformIgnorePatterns` is deliberately NOT set here. The pattern in every
 * Expo tutorial is the pre-pnpm one, and Jest replaces the preset's value with
 * the project's rather than merging it — so copying that pattern in silently
 * *removes* jest-expo's own, which already allows `.pnpm` paths through. It is
 * one of the few keys where saying nothing is strictly better than repeating
 * the documentation.
 *
 * `moduleNameMapper`, by contrast, Jest merges over the preset's, which is why
 * the one entry below is safe. See test/assets-registry-stub.js for what it is
 * standing in for.
 *
 * What these tests can and cannot prove is recorded in `src/lib/api-client.ts`:
 * they render components and touch no API. The contract proof lives in the
 * API's own e2e suite, `test/mobile-client.e2e-spec.ts`.
 */
module.exports = {
  preset: 'jest-expo',
  moduleNameMapper: {
    '^@react-native/assets-registry/registry$': '<rootDir>/test/assets-registry-stub.js',
  },
};
