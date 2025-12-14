import { getCwd, p } from "@hot-updater/cli-tools";
import fs from "fs";
import path from "path";

/**
 * Checks if the project is using Expo CNG (Continuous Native Generation).
 * Returns true if expo package is installed and app.json or app.config.{js,mjs,ts,mts,cjs,cts} file exists.
 */
export function isExpoCNG(): boolean {
  // Check if expo package is installed
  try {
    require.resolve("expo/package.json");
  } catch {
    return false;
  }

  const cwd = getCwd();

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

export function isExpo(): boolean {
  try {
    require.resolve("expo/package.json");
    return true;
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
    '  "plugins": [["@hot-updater/react-native", { "channel": "production" }]]',
  );
  p.log.info("  Instead run `npx expo prebuild`.");
  console.log("");
}
