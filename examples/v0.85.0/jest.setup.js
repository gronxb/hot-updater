const defaultState = {
  artifactType: null,
  details: null,
  isUpdateDownloaded: false,
  progress: 0,
};

jest.mock("@hot-updater/react-native", () => ({
  HotUpdater: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    checkForUpdate: jest.fn(() => Promise.resolve(null)),
    clearCrashHistory: jest.fn(() => true),
    getAppVersion: jest.fn(() => "1.0.0"),
    getBaseURL: jest.fn(() => null),
    getBundleId: jest.fn(() => "00000000-0000-0000-0000-000000000000"),
    getChannel: jest.fn(() => "production"),
    getCohort: jest.fn(() => "0"),
    getCrashHistory: jest.fn(() => []),
    getDefaultChannel: jest.fn(() => "production"),
    getFingerprintHash: jest.fn(() => null),
    getManifest: jest.fn(() => ({
      assets: {},
      bundleId: "00000000-0000-0000-0000-000000000000",
    })),
    getMinBundleId: jest.fn(() => "00000000-0000-0000-0000-000000000000"),
    isChannelSwitched: jest.fn(() => false),
    isUpdateDownloaded: jest.fn(() => false),
    reload: jest.fn(() => Promise.resolve()),
    resetChannel: jest.fn(() => Promise.resolve(true)),
    setCohort: jest.fn(),
    setReloadBehavior: jest.fn(),
    wrap: jest.fn(() => (Component) => Component),
  },
  useHotUpdaterStore: jest.fn((selector = (state) => state) =>
    selector(defaultState),
  ),
}));

jest.mock("react-native-bootsplash", () => ({
  hide: jest.fn(() => Promise.resolve()),
}));
