import fs from "fs";
import path from "path";

import { getCwd, p } from "@hot-updater/cli-tools";

/**
 * Checks if the project is using Expo CNG (Continuous Native Generation).
 * Returns true if expo package is installed and app.json or app.config.{js,mjs,ts,mts,cjs,cts} file exists.
 */
export function isExpoCNG(cwd = getCwd()): boolean {
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

/** Whether `projectPath` is a One app: it depends on `one` and has a vite config. */
export function isOne(projectPath = getCwd()): boolean {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectPath, "package.json"), "utf-8"),
    );
    const dependsOnOne = [
      packageJson.dependencies,
      packageJson.devDependencies,
    ].some((dependencies) => dependencies?.one != null);
    return (
      dependsOnOne &&
      ["ts", "mts", "js", "mjs", "cts", "cjs"].some((ext) =>
        fs.existsSync(path.join(projectPath, `vite.config.${ext}`)),
      )
    );
  } catch {
    return false;
  }
}

/** A framework whose prebuild generates the project's native folders. */
export type PrebuildFramework = "expo" | "one";

/** How each framework's prebuild is configured and run. */
export const PREBUILD_FRAMEWORKS: Record<
  PrebuildFramework,
  {
    readonly label: string;
    readonly command: string;
    readonly configFile: string;
    readonly pluginEntry: string;
  }
> = {
  expo: {
    label: "Expo",
    command: "npx expo prebuild",
    configFile: "app.json or app.config.js",
    pluginEntry:
      '"plugins": [["@hot-updater/expo", { "channel": "production" }]]',
  },
  one: {
    label: "One",
    command: "npx one prebuild",
    configFile: "vite.config.ts (native.app)",
    pluginEntry: 'plugins: [["@hot-updater/one", { channel: "production" }]]',
  },
};

/**
 * The framework whose prebuild generates this project's native folders: an
 * Expo CNG project, or a One app (One prebuild always generates them).
 */
export function getPrebuildFramework(cwd = getCwd()): PrebuildFramework | null {
  if (isExpoCNG(cwd)) return "expo";
  if (isOne(cwd)) return "one";
  return null;
}

/**
 * Warns when prebuild generates the native files a command is about to
 * edit. Call this once at the start of commands that use native parsers.
 */
export function warnIfPrebuildGenerated(): void {
  const framework = getPrebuildFramework();
  if (framework === null) {
    return;
  }
  const { label, command, configFile, pluginEntry } =
    PREBUILD_FRAMEWORKS[framework];

  console.log("");
  p.log.warn(`${label} project detected; prebuild generates its native files:`);
  p.log.info(`Configure in ${configFile}:`);
  p.log.info(`  ${pluginEntry}`);
  p.log.info(`  Instead run \`${command}\`.`);
  console.log("");
}
