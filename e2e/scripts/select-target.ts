#!/usr/bin/env tsx

import * as p from "@clack/prompts";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import color from "picocolors";

const EXAMPLES_DIR = path.resolve(__dirname, "../../examples");

interface AppInfo {
  key: string;
  name: string;
  path: string;
  hasIos: boolean;
  hasAndroid: boolean;
}

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

    // Skip if no package.json
    if (!fs.existsSync(packageJsonPath)) continue;

    const hasIos = fs.existsSync(path.join(appPath, "ios"));
    const hasAndroid = fs.existsSync(path.join(appPath, "android"));

    // Skip if no native directories
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

    apps.push({
      key: entry.name,
      name: displayName,
      path: appPath,
      hasIos,
      hasAndroid,
    });
  }

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

function getConfigurationName(appKey: string, platform: string): string {
  // Convert folder name to configuration key
  // e.g., "expo-52" -> "expo52", "v0.81.0" -> "v0810"
  const key = appKey.replace(/[.-]/g, "");
  return `${key}.${platform}`;
}

async function main() {
  console.clear();

  p.intro(color.bgCyan(color.black(" Hot Updater E2E Test Runner ")));

  const apps = detectExampleApps();

  if (apps.length === 0) {
    p.log.error("No example apps found in ../examples/");
    p.outro("Please ensure example apps exist with iOS or Android directories");
    process.exit(1);
  }

  // Select app
  const selectedApp = await p.select({
    message: "Select the app to test:",
    options: apps.map((app) => ({
      value: app.key,
      label: app.name,
      hint: `${app.hasIos ? "iOS" : ""} ${app.hasIos && app.hasAndroid ? "+" : ""} ${app.hasAndroid ? "Android" : ""}`.trim(),
    })),
  });

  if (p.isCancel(selectedApp)) {
    p.cancel("Operation cancelled");
    process.exit(0);
  }

  const app = apps.find((a) => a.key === selectedApp);
  if (!app) {
    p.log.error("App not found");
    process.exit(1);
  }

  // Select platform
  const platformOptions: Array<{ value: string; label: string }> = [];
  if (app.hasIos) {
    platformOptions.push({ value: "ios", label: "iOS" });
  }
  if (app.hasAndroid) {
    platformOptions.push({ value: "android", label: "Android" });
  }

  if (platformOptions.length === 0) {
    p.log.error("No platforms available for this app");
    process.exit(1);
  }

  const platform = await p.select({
    message: "Select the platform:",
    options: platformOptions,
  });

  if (p.isCancel(platform)) {
    p.cancel("Operation cancelled");
    process.exit(0);
  }

  const configuration = getConfigurationName(app.key, platform as string);

  p.note(
    `App: ${color.cyan(app.name)}\nPlatform: ${color.cyan(platform)}\nConfiguration: ${color.cyan(configuration)}\nAction: ${color.cyan("Build & Test")}`,
    "Test Configuration",
  );

  const shouldProceed = await p.confirm({
    message: "Start build and test?",
    initialValue: true,
  });

  if (p.isCancel(shouldProceed) || !shouldProceed) {
    p.cancel("Operation cancelled");
    process.exit(0);
  }

  const s = p.spinner();

  try {
    // Build
    s.start(`Building ${app.name} for ${platform}...`);
    execSync(`detox build --configuration ${configuration}`, {
      stdio: "inherit",
    });
    s.stop(`Build completed for ${configuration}`);

    // Test
    s.start(`Running tests for ${configuration}...`);
    execSync(`detox test --configuration ${configuration}`, {
      stdio: "inherit",
    });
    s.stop(`Tests completed for ${configuration}`);

    p.outro(color.green("All tests passed successfully! 🎉"));
  } catch (error) {
    s.stop("Operation failed");
    p.log.error("Build or test failed");
    if (error instanceof Error) {
      p.log.error(error.message);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  p.log.error("An unexpected error occurred");
  console.error(error);
  process.exit(1);
});
