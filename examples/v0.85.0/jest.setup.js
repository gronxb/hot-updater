/* global jest */

const defaultState = {
  artifactType: null,
  details: null,
  isUpdateDownloaded: false,
  progress: 0,
};

// e2e-build-config.cjs writes this before bundling; a test has no build.
jest.mock(
  "./src/e2eBuildConfig",
  () => ({
    HOT_UPDATER_API_KEY: undefined,
    HOT_UPDATER_APP_BASE_URL: undefined,
    HOT_UPDATER_E2E_RUNTIME_CONFIG_URL: undefined,
  }),
  { virtual: true },
);

jest.mock("@hot-updater/react-native", () => {
  const remoteConfigValues = {};
  // What HotUpdater.init returns: the instance's methods and plugin APIs.
  const instance = {
    addListener: jest.fn(() => () => {}),
    checkForUpdate: jest.fn(() => Promise.resolve(null)),
    clearCrashHistory: jest.fn(() => true),
    getAppVersion: jest.fn(() => "1.0.0"),
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
    getMinBundleId: jest.fn(
      () => "00000000-0000-0000-0000-000000000000",
    ),
    isChannelSwitched: jest.fn(() => false),
    isUpdateDownloaded: jest.fn(() => false),
    reload: jest.fn(() => Promise.resolve()),
    resetChannel: jest.fn(() => Promise.resolve(true)),
    setCohort: jest.fn(),
    setReloadBehavior: jest.fn(),
    wrap: jest.fn(() => (Component) => Component),
    insights: { setUser: jest.fn() },
    remoteConfig: {
      activate: jest.fn(() => Promise.resolve(false)),
      fetch: jest.fn(() => Promise.resolve()),
      fetchAndActivate: jest.fn(() => Promise.resolve(false)),
      // A stable snapshot, as useSyncExternalStore needs.
      getAll: jest.fn(() => remoteConfigValues),
      getValue: jest.fn(() => ({
        asBoolean: () => false,
        asNumber: () => 0,
        asString: () => "",
        getSource: () => "default",
      })),
      lastFetchStatus: "no-fetch-yet",
      subscribe: jest.fn(() => () => {}),
    },
  };
  return {
    HotUpdater: { init: jest.fn(() => instance) },
    insights: jest.fn(() => ({ id: "insights", setup: jest.fn() })),
    remoteConfig: jest.fn(() => ({ id: "remoteConfig", setup: jest.fn() })),
    useHotUpdaterStore: jest.fn((selector = (state) => state) =>
      selector(defaultState),
    ),
  };
});

// The provider renders nothing until it measures insets, which a test never
// lays out; the library's mock gives it fixed metrics.
jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);

jest.mock("react-native-bootsplash", () => ({
  hide: jest.fn(() => Promise.resolve()),
}));

jest.mock("react-native-launch-arguments", () => ({
  LaunchArguments: { value: jest.fn(() => ({})) },
}));

jest.mock("react-native-screens", () =>
  Object.create(jest.requireActual("react-native-screens"), {
    enableScreens: { value: jest.fn() },
  }),
);
