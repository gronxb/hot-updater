#!/usr/bin/env tsx

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const EXAMPLES_DIR = path.resolve(__dirname, "../../examples");
const BUILD_DIR = path.resolve(__dirname, "../build");

const CLEANUP_PATHS = {
  expo52: {
    ios: [
      path.join(EXAMPLES_DIR, "expo-52/ios/build"),
      path.join(EXAMPLES_DIR, "expo-52/ios/Pods"),
    ],
    android: [
      path.join(EXAMPLES_DIR, "expo-52/android/build"),
      path.join(EXAMPLES_DIR, "expo-52/android/app/build"),
      path.join(EXAMPLES_DIR, "expo-52/android/.gradle"),
    ],
  },
  v0810: {
    ios: [
      path.join(EXAMPLES_DIR, "v0.81.0/ios/build"),
      path.join(EXAMPLES_DIR, "v0.81.0/ios/Pods"),
    ],
    android: [
      path.join(EXAMPLES_DIR, "v0.81.0/android/build"),
      path.join(EXAMPLES_DIR, "v0.81.0/android/app/build"),
      path.join(EXAMPLES_DIR, "v0.81.0/android/.gradle"),
    ],
  },
  v0770: {
    ios: [
      path.join(EXAMPLES_DIR, "v0.77.0/ios/build"),
      path.join(EXAMPLES_DIR, "v0.77.0/ios/Pods"),
    ],
    android: [
      path.join(EXAMPLES_DIR, "v0.77.0/android/build"),
      path.join(EXAMPLES_DIR, "v0.77.0/android/app/build"),
      path.join(EXAMPLES_DIR, "v0.77.0/android/.gradle"),
    ],
  },
  v0761newarch: {
    ios: [
      path.join(EXAMPLES_DIR, "v0.76.1-new-arch/ios/build"),
      path.join(EXAMPLES_DIR, "v0.76.1-new-arch/ios/Pods"),
    ],
    android: [
      path.join(EXAMPLES_DIR, "v0.76.1-new-arch/android/build"),
      path.join(EXAMPLES_DIR, "v0.76.1-new-arch/android/app/build"),
      path.join(EXAMPLES_DIR, "v0.76.1-new-arch/android/.gradle"),
    ],
  },
};

function removePath(targetPath: string) {
  if (fs.existsSync(targetPath)) {
    console.log(`🗑️  Removing: ${targetPath}`);
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      console.log(`  ✅ Removed successfully\n`);
    } catch (error) {
      console.error(`  ❌ Failed to remove: ${error}\n`);
    }
  } else {
    console.log(`  ⏭️  Skipping (doesn't exist): ${targetPath}\n`);
  }
}

function cleanupAll() {
  console.log("\n🧹 Cleaning up all build artifacts...\n");

  // Clean e2e build directory
  removePath(BUILD_DIR);

  // Clean all example apps
  for (const [appKey, paths] of Object.entries(CLEANUP_PATHS)) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Cleaning ${appKey}...`);
    console.log(`${"=".repeat(60)}\n`);

    for (const platformPaths of Object.values(paths)) {
      for (const targetPath of platformPaths) {
        removePath(targetPath);
      }
    }
  }

  console.log("\n✅ Cleanup completed!\n");
}

function cleanupApp(
  app: keyof typeof CLEANUP_PATHS,
  platform?: "ios" | "android",
) {
  console.log(`\n🧹 Cleaning up ${app}${platform ? ` (${platform})` : ""}...\n`);

  const paths = CLEANUP_PATHS[app];

  if (platform) {
    for (const targetPath of paths[platform]) {
      removePath(targetPath);
    }
  } else {
    for (const platformPaths of Object.values(paths)) {
      for (const targetPath of platformPaths) {
        removePath(targetPath);
      }
    }
  }

  console.log(`\n✅ Cleanup completed for ${app}!\n`);
}

function parseArgs(): {
  target?: keyof typeof CLEANUP_PATHS | "all";
  platform?: "ios" | "android";
} {
  const args = process.argv.slice(2);
  let target: keyof typeof CLEANUP_PATHS | "all" | undefined;
  let platform: "ios" | "android" | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--target" || arg === "-t") {
      target = args[i + 1] as keyof typeof CLEANUP_PATHS | "all";
      i++;
    } else if (arg === "--platform" || arg === "-p") {
      platform = args[i + 1] as "ios" | "android";
      i++;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: pnpm clean [options]

Options:
  --target, -t <target>      Target app to clean (expo52, v0810, v0770, v0761newarch, all)
  --platform, -p <platform>  Platform to clean (ios, android)
  --help, -h                 Show this help message

Examples:
  pnpm clean --target all
  pnpm clean --target expo52 --platform ios
  pnpm clean -t v0810 -p android
      `);
      process.exit(0);
    }
  }

  return { target, platform };
}

function main() {
  const { target, platform } = parseArgs();

  console.log("\n" + "=".repeat(60));
  console.log("🧹 Hot Updater E2E Build Cleanup");
  console.log("=".repeat(60));

  if (!target || target === "all") {
    cleanupAll();
  } else {
    if (!(target in CLEANUP_PATHS)) {
      console.error(
        `\n❌ Invalid target: ${target}. Valid targets: expo52, v0810, v0770, v0761newarch, all\n`,
      );
      process.exit(1);
    }

    cleanupApp(target as keyof typeof CLEANUP_PATHS, platform);
  }
}

main();
