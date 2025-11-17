const fs = require("node:fs");
const path = require("node:path");

const EXAMPLES_DIR = path.resolve(__dirname, "../examples");

function detectExampleApps() {
  if (!fs.existsSync(EXAMPLES_DIR)) {
    return [];
  }

  const entries = fs.readdirSync(EXAMPLES_DIR, { withFileTypes: true });
  const apps = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const appPath = path.join(EXAMPLES_DIR, entry.name);
    const packageJsonPath = path.join(appPath, "package.json");

    if (!fs.existsSync(packageJsonPath)) continue;

    const hasIos = fs.existsSync(path.join(appPath, "ios"));
    const hasAndroid = fs.existsSync(path.join(appPath, "android"));

    if (!hasIos && !hasAndroid) continue;

    // Detect iOS scheme name
    let iosSchemeName = null;
    if (hasIos) {
      const iosDir = path.join(appPath, "ios");
      const iosFiles = fs.readdirSync(iosDir);
      const workspaceFile = iosFiles.find((f) => f.endsWith(".xcworkspace"));
      if (workspaceFile) {
        iosSchemeName = workspaceFile.replace(".xcworkspace", "");
      }
    }

    apps.push({
      key: entry.name,
      folderName: entry.name,
      hasIos,
      hasAndroid,
      iosSchemeName,
    });
  }

  return apps;
}

function getConfigKey(folderName) {
  // Convert folder name to config key
  // e.g., "expo-52" -> "expo52", "v0.81.0" -> "v0810"
  return folderName.replace(/[.-]/g, "");
}

function generateAppsConfig() {
  const apps = detectExampleApps();
  const config = {};

  for (const app of apps) {
    const configKey = getConfigKey(app.folderName);
    const examplePath = `../examples/${app.folderName}`;

    if (app.hasIos && app.iosSchemeName) {
      const schemeName = app.iosSchemeName;
      config[`${configKey}.ios.release`] = {
        type: "ios.app",
        binaryPath: `${examplePath}/ios/build/Build/Products/Release-iphonesimulator/${schemeName}.app`,
        build: app.folderName.startsWith("expo")
          ? `cd ${examplePath} && npx expo prebuild && xcodebuild -workspace ios/${schemeName}.xcworkspace -scheme ${schemeName} -configuration Release -sdk iphonesimulator -derivedDataPath ios/build`
          : `cd ${examplePath} && xcodebuild -workspace ios/${schemeName}.xcworkspace -scheme ${schemeName} -configuration Release -sdk iphonesimulator -derivedDataPath ios/build`,
      };
    }

    if (app.hasAndroid) {
      config[`${configKey}.android.release`] = {
        type: "android.apk",
        binaryPath: `${examplePath}/android/app/build/outputs/apk/release/app-release.apk`,
        build: app.folderName.startsWith("expo")
          ? `cd ${examplePath} && npx expo prebuild && cd android && ./gradlew assembleRelease assembleAndroidTest -DtestBuildType=release`
          : `cd ${examplePath}/android && ./gradlew assembleRelease assembleAndroidTest -DtestBuildType=release`,
        reversePorts: [8081],
      };
    }
  }

  return config;
}

function generateConfigurations() {
  const apps = detectExampleApps();
  const config = {};

  for (const app of apps) {
    const configKey = getConfigKey(app.folderName);

    if (app.hasIos && app.iosSchemeName) {
      config[`${configKey}.ios`] = {
        device: "simulator",
        app: `${configKey}.ios.release`,
      };
    }

    if (app.hasAndroid) {
      config[`${configKey}.android`] = {
        device: "emulator",
        app: `${configKey}.android.release`,
      };
    }
  }

  return config;
}

/** @type {Detox.DetoxConfig} */
module.exports = {
  testRunner: {
    args: {
      $0: "jest",
      config: "e2e/jest.config.js",
    },
    jest: {
      setupTimeout: 120000,
    },
  },
  apps: generateAppsConfig(),
  devices: {
    simulator: {
      type: "ios.simulator",
      device: {
        type: "iPhone 16",
      },
    },
    emulator: {
      type: "android.emulator",
      device: {
        avdName: "Pixel_8_API_35",
      },
    },
  },
  configurations: generateConfigurations(),
};
