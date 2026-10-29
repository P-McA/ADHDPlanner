/**
 * A resolvable, populated asset registry for Jest.
 *
 * React Native 0.88 exports `AssetRegistry` from
 * `src/private/assets/AssetRegistry`, but jest-expo 58 still mocks the older
 * `react-native/asset-registry` entry point. The mock therefore never applies,
 * and `expo-asset` sees the real registry — empty under Jest — then throws
 * `Module "1" is missing from the asset registry` when a font is required.
 *
 * The metadata shape is the one jest-expo's own mock returns.
 */
const meta = {
  fileSystemLocation: '/full/path/to/directory',
  httpServerLocation: '/assets/full/path/to/directory',
  scales: [1],
  fileHashes: ['md5'],
  name: 'name',
  exists: true,
  type: 'type',
  hash: 'md5',
  uri: 'uri',
  width: 1,
  height: 1,
};

module.exports = {
  AssetRegistry: {
    registerAsset: () => 1,
    getAssetByID: () => meta,
  },
};
