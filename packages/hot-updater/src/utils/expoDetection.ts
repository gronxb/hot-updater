import fs from "fs";
import path from "path";

import {
  type ConfigResponse,
  getCwd,
  loadConfig,
  p,
} from "@hot-updater/cli-tools";

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
 * Whether the Expo config lists the `@hot-updater/expo` config plugin, as the
 * build adapter reads the config: its prebuild writes a channel only then.
 * Null when the adapter can't say.
 */
const listsHotUpdaterPlugin = async (
  cwd: string,
  config: Pick<ConfigResponse, "build">,
): Promise<boolean | null> => {
  try {
    const adapter = await config.build({ cwd });
    const values = await adapter.nativeBuild?.getNativeProjectValues?.({
      platform: "ios",
    });
    return values === undefined ? null : values.channel !== undefined;
  } catch {
    return null;
  }
};

/**
 * Warns an Expo CNG project whose Expo config doesn't list the
 * `@hot-updater/expo` config plugin, which `npx expo prebuild` needs to keep
 * Hot Updater's native setup. Call this once at the start of commands that
 * use native parsers.
 */
export async function warnIfExpoCNG({
  cwd = getCwd(),
  config,
}: {
  cwd?: string;
  config?: Pick<ConfigResponse, "build">;
} = {}): Promise<void> {
  if (!isExpoCNG(cwd)) {
    return;
  }
  if (await listsHotUpdaterPlugin(cwd, config ?? (await loadConfig(null)))) {
    return;
  }

  p.log.warn(
    [
      "Expo CNG project: npx expo prebuild regenerates the native files.",
      "Configure the @hot-updater/expo plugin in app.json or app.config.*:",
    ].join("\n"),
  );
  // Its own line: a warning reads a JSON value in it as a provider's
  // error body and prints only the strings inside.
  p.log.message(
    '"plugins": [["@hot-updater/expo", { "channel": "production" }]]',
  );
}
