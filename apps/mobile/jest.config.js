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
  // Raised from Jest's 5 s default: the first test in a file pays for a cold
  // React Native transform, and on a CI runner that alone overran 5 s once
  // (home-screen.test.tsx, commit 14217b6 — passed untouched on re-run). The
  // default was measuring the runner, not the code; 20 s still fails a hang.
  testTimeout: 20_000,
  moduleNameMapper: {
    '^@react-native/assets-registry/registry$': '<rootDir>/test/assets-registry-stub.js',
    // The microphone is native; see test/expo-audio-fake.ts.
    '^expo-audio$': '<rootDir>/test/expo-audio-fake.ts',
    // Clerk's SDK is native + network; see test/clerk-expo-fake.tsx.
    '^@clerk/expo$': '<rootDir>/test/clerk-expo-fake.tsx',
    '^@clerk/expo/token-cache$': '<rootDir>/test/clerk-expo-fake.tsx',
  },
};
