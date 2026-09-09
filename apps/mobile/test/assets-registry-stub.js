/**
 * A resolvable target for `@react-native/assets-registry/registry`.
 *
 * jest-expo's preset opens with an unconditional
 * `jest.mock('@react-native/assets-registry/registry', () => ({ … }))`. React
 * Native 0.87 no longer ships that package — the whole graph has no reference to
 * it (`grep assets-registry pnpm-lock.yaml` finds nothing), so the mock throws
 * "Cannot find module" before a single test runs. It is not a pnpm layout
 * problem: npm would hoist the same absent package.
 *
 * `jest.mock` still has to *resolve* a specifier before replacing it, so this
 * file exists only to be resolvable. Its contents are never read: the preset's
 * own factory is what every caller gets. Deleting the mapping in jest.config.js
 * reproduces the failure exactly.
 */
module.exports = {
  registerAsset: () => 1,
  getAssetByID: () => undefined,
};
