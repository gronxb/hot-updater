function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const iosSimulatorName =
  process.env.HOT_UPDATER_E2E_IOS_SIMULATOR_NAME || "iPhone 16";
const iosDestination = process.env.HOT_UPDATER_E2E_DEVICE_ID
  ? `id=${process.env.HOT_UPDATER_E2E_DEVICE_ID}`
  : `platform=iOS Simulator,name=${iosSimulatorName}`;
const androidArchitectures =
  process.env.HOT_UPDATER_E2E_ANDROID_ARCHITECTURES || "arm64-v8a,x86_64";

module.exports = {
  testRunner: {
    args: {
      $0: "jest",
      config: "e2e/detox/jest.config.js",
    },
    jest: {
      setupTimeout: 120000,
    },
  },
  apps: {
    "ios.release": {
      type: "ios.app",
      binaryPath:
        process.env.HOT_UPDATER_E2E_IOS_BINARY_PATH ||
        "examples/v0.85.0/ios/build/Build/Products/Release-iphonesimulator/HotUpdaterExample.app",
      build:
        `cd examples/v0.85.0/ios && RCT_USE_PREBUILT_RNCORE=1 RCT_USE_RN_DEP=1 bundle exec pod install && xcodebuild -workspace HotUpdaterExample.xcworkspace -scheme HotUpdaterExample -configuration Release -sdk iphonesimulator -destination ${shellSingleQuote(iosDestination)} -derivedDataPath build -quiet HOT_UPDATER_MIN_BUNDLE_ID=00000000-0000-7000-8000-000000000000`,
    },
    "android.release": {
      type: "android.apk",
      binaryPath:
        process.env.HOT_UPDATER_E2E_ANDROID_BINARY_PATH ||
        "examples/v0.85.0/android/app/build/outputs/apk/release/app-release.apk",
      testBinaryPath:
        process.env.HOT_UPDATER_E2E_ANDROID_TEST_BINARY_PATH ||
        "examples/v0.85.0/android/app/build/outputs/apk/androidTest/release/app-release-androidTest.apk",
      build:
        `cd examples/v0.85.0/android && ./gradlew assembleRelease assembleAndroidTest -DtestBuildType=release -PreactNativeArchitectures=${androidArchitectures} -PHOT_UPDATER_E2E_DEBUGGABLE=true -PMIN_BUNDLE_ID=00000000-0000-7000-8000-000000000000`,
    },
  },
  devices: {
    simulator: {
      type: "ios.simulator",
      device: {
        type: iosSimulatorName,
      },
    },
    androidAttached: {
      type: "android.attached",
      device: {
        adbName: process.env.HOT_UPDATER_E2E_ANDROID_SERIAL || ".*",
      },
    },
  },
  configurations: {
    "ios.sim.release": {
      device: "simulator",
      app: "ios.release",
    },
    "android.emu.release": {
      device: "androidAttached",
      app: "android.release",
    },
  },
};
