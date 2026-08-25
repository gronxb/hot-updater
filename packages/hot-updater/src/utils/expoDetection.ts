import fs from "fs";
import path from "path";

import { getCwd, p } from "@hot-updater/cli-tools";

/**
 * Checks if the project is using Expo CNG (Continuous Native Generation).
 * Returns true if expo package is installed and app.json or app.config.{js,mjs,ts,mts,cjs,cts} file exists.
 */
export function isExpoCNG(): boolean {
  const cwd = getCwd();
  if (!isExpo(cwd)) {
    return false;
  }

  // Check app.json
  const appJsonPath = path.join(cwd, "app.json");
  if (fs.existsSync(appJsonPath)) {
    try {
      const appJsonContent = fs.readFileSync(appJsonPath, "utf-8");
      const appJson = JSON.parse(appJsonContent);
      if (appJson.expo) {
        return true;
      }
    } catch {
      // Invalid JSON, continue checking
    }
  }

  // Check app.config.{js,mjs,ts,mts,cjs,cts} files
  const configExtensions = ["js", "mjs", "cjs", "ts", "mts", "cts"];
  return configExtensions.some((ext) => {
    const configPath = path.join(cwd, `app.config.${ext}`);
    return fs.existsSync(configPath);
  });
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

  console.log("");
  p.log.warn("Expo CNG project detected:");
  p.log.info("Configure in app.json or app.config.js:");
  p.log.info(
    '  "plugins": [["@hot-updater/expo", { "channel": "production" }]]',
  );
  p.log.info("  Instead run `npx expo prebuild`.");
  console.log("");
}
