#!/usr/bin/env tsx

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type Platform = "ios" | "android" | "both";

interface BuildOptions {
  target: string;
  platform: Platform;
}

interface AppInfo {
  key: string;
  name: string;
  path: string;
  hasIos: boolean;
  hasAndroid: boolean;
  iosSchemeName: string | null;
}

const EXAMPLES_DIR = path.resolve(__dirname, "../../examples");

function detectExampleApps(): AppInfo[] {
  if (!fs.existsSync(EXAMPLES_DIR)) {
    return [];
  }

  const entries = fs.readdirSync(EXAMPLES_DIR, { withFileTypes: true });
  const apps: AppInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const appPath = path.join(EXAMPLES_DIR, entry.name);
    const packageJsonPath = path.join(appPath, "package.json");

    if (!fs.existsSync(packageJsonPath)) continue;

    const hasIos = fs.existsSync(path.join(appPath, "ios"));
    const hasAndroid = fs.existsSync(path.join(appPath, "android"));

    if (!hasIos && !hasAndroid) continue;

    let displayName = entry.name;
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf-8"),
      );
      displayName = packageJson.name || entry.name;
    } catch {
      // Use folder name if package.json can't be read
    }

    // Detect iOS scheme name
    let iosSchemeName: string | null = null;
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
      name: displayName,
      path: appPath,
      hasIos,
      hasAndroid,
      iosSchemeName,
    });
  }

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

function execCommand(command: string, cwd: string) {
  console.log(`\n📦 Executing: ${command}`);
  console.log(`📁 Working directory: ${cwd}\n`);

  try {
    execSync(command, {
      cwd,
      stdio: "inherit",
      env: { ...process.env },
    });
    console.log("✅ Command completed successfully\n");
  } catch (error) {
    console.error("❌ Command failed\n");
    throw error;
  }
}

function getConfigKey(folderName: string): string {
  return folderName.replace(/[.-]/g, "");
}

function buildIOS(app: AppInfo) {
  console.log(`\n🍎 Building iOS for ${app.name}...`);

  if (!app.iosSchemeName) {
    console.error(`❌ No iOS scheme found for ${app.name}`);
    throw new Error(`No iOS scheme found for ${app.name}`);
  }

  const schemeName = app.iosSchemeName;

  // Install npm dependencies if node_modules doesn't exist
  const nodeModulesPath = path.join(app.path, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    console.log("📦 Installing dependencies...");
    execCommand("pnpm install", app.path);
  }

  // For Expo apps, run prebuild first
  if (app.key.startsWith("expo")) {
    execCommand("npx expo prebuild --platform ios --clean", app.path);
  }

  // Install pods
  const iosPath = path.join(app.path, "ios");
  if (fs.existsSync(iosPath)) {
    execCommand("bundle install && bundle exec pod install", iosPath);
  }

  // Build the app
  const buildCommand = `xcodebuild -workspace ios/${schemeName}.xcworkspace -scheme ${schemeName} -configuration Release -sdk iphonesimulator -derivedDataPath ios/build`;
  execCommand(buildCommand, app.path);

  console.log(`✅ iOS build completed for ${app.name}`);
}

function buildAndroid(app: AppInfo) {
  console.log(`\n🤖 Building Android for ${app.name}...`);

  // Install npm dependencies if node_modules doesn't exist
  const nodeModulesPath = path.join(app.path, "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    console.log("📦 Installing dependencies...");
    execCommand("pnpm install", app.path);
  }

  // For Expo apps, run prebuild first
  if (app.key.startsWith("expo")) {
    execCommand("npx expo prebuild --platform android --clean", app.path);
  }

  // Build the APK
  const androidPath = path.join(app.path, "android");
  execCommand(
    "./gradlew assembleRelease assembleAndroidTest -DtestBuildType=release",
    androidPath,
  );

  console.log(`✅ Android build completed for ${app.name}`);
}

function buildApp(app: AppInfo, platform: Platform) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 Building ${app.name}`);
  console.log(`${"=".repeat(60)}`);

  if (platform === "ios" || platform === "both") {
    if (app.hasIos) {
      buildIOS(app);
    } else {
      console.log(`⏭️  Skipping iOS (not available for ${app.name})`);
    }
  }

  if (platform === "android" || platform === "both") {
    if (app.hasAndroid) {
      buildAndroid(app);
    } else {
      console.log(`⏭️  Skipping Android (not available for ${app.name})`);
    }
  }
}

function parseArgs(): BuildOptions {
  const args = process.argv.slice(2);

  let target = "all";
  let platform: Platform = "both";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--target" || arg === "-t") {
      target = args[i + 1];
      i++;
    } else if (arg === "--platform" || arg === "-p") {
      platform = args[i + 1] as Platform;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      const apps = detectExampleApps();
      const appsList = apps.map((a) => a.key).join(", ");

      console.log(`
Usage: pnpm build:apps [options]

Options:
  --target, -t <target>      Target app to build (${appsList}, all)
  --platform, -p <platform>  Platform to build (ios, android, both)
  --help, -h                 Show this help message

Examples:
  pnpm build:apps --target expo-52 --platform ios
  pnpm build:apps --target all --platform both
  pnpm build:apps -t v0.81.0 -p android
      `);
      process.exit(0);
    }
  }

  return { target, platform };
}

function main() {
  const options = parseArgs();
  const apps = detectExampleApps();

  if (apps.length === 0) {
    console.error("❌ No example apps found in ../examples/");
    process.exit(1);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("🏗️  Hot Updater E2E Test App Builder");
  console.log(`${"=".repeat(60)}`);
  console.log(`Target: ${options.target}`);
  console.log(`Platform: ${options.platform}`);
  console.log(`${"=".repeat(60)}\n`);

  if (options.target === "all") {
    for (const app of apps) {
      try {
        buildApp(app, options.platform);
      } catch (error) {
        console.error(`❌ Failed to build ${app.name}`);
        console.error(error);
        process.exit(1);
      }
    }
  } else {
    const app = apps.find((a) => a.key === options.target);

    if (!app) {
      console.error(`❌ App not found: ${options.target}`);
      console.error(`Available apps: ${apps.map((a) => a.key).join(", ")}`);
      process.exit(1);
    }

    try {
      buildApp(app, options.platform);
    } catch (error) {
      console.error(`❌ Failed to build ${app.name}`);
      console.error(error);
      process.exit(1);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("🎉 All builds completed successfully!");
  console.log(`${"=".repeat(60)}\n`);
}

main();
