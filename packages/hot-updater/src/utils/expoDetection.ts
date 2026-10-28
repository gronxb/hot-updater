import fs from "fs";
import path from "path";

import { getCwd, p } from "@hot-updater/cli-tools";

/**
 * The Expo config file of a project that uses Expo CNG (Continuous Native
 * Generation), in a project with the expo package installed: its
 * `app.config.{js,mjs,ts,mts,cjs,cts}`, which takes `app.json` and can
 * override it, so it decides the build's config, else `app.json` with an
 * `expo` key. Null otherwise.
 */
export function expoConfigFile(cwd = getCwd()): string | null {
  if (!isExpo(cwd)) {
    return null;
  }

  // Check app.config.{js,mjs,ts,mts,cjs,cts} files
  const configExtensions = ["js", "mjs", "cjs", "ts", "mts", "cts"];
  const extension = configExtensions.find((ext) =>
    fs.existsSync(path.join(cwd, `app.config.${ext}`)),
  );
  if (extension !== undefined) {
    return `app.config.${extension}`;
  }

  // Check app.json
  const appJsonPath = path.join(cwd, "app.json");
  if (fs.existsSync(appJsonPath)) {
    try {
      const appJsonContent = fs.readFileSync(appJsonPath, "utf-8");
      const appJson = JSON.parse(appJsonContent);
      if (appJson.expo) {
        return "app.json";
      }
    } catch {
      // Invalid JSON
    }
  }
  return null;
}

/**
 * Checks if the project is using Expo CNG (Continuous Native Generation).
 * Returns true if expo package is installed and app.json or app.config.{js,mjs,ts,mts,cjs,cts} file exists.
 */
export function isExpoCNG(cwd = getCwd()): boolean {
  return expoConfigFile(cwd) !== null;
}

export function isExpo(projectPath = getCwd()): boolean {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectPath, "package.json"), "utf-8"),
    );
    return [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.optionalDependencies,
      packageJson.peerDependencies,
    ].some((dependencies) => dependencies?.expo != null);
  } catch {
    return false;
  }
}

/**
 * Shows warning if the project is Expo CNG.
 * Call this once at the start of commands that use native parsers.
 */
export function warnIfExpoCNG(): void {
  if (!isExpoCNG()) {
    return;
  }

  p.log.warn(
    [
      "Expo CNG project: npx expo prebuild regenerates the native files.",
      "Configure the @hot-updater/expo plugin in app.json or app.config.*:",
      '"plugins": [["@hot-updater/expo", { "channel": "production" }]]',
    ].join("\n"),
  );
}
