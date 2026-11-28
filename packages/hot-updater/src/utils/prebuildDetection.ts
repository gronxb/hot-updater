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
 * Whether `projectPath` is a One app: it depends on `one` and has a vite
 * config. `one prebuild` always generates its native folders.
 */
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

/**
 * The framework whose prebuild generates the project's native folders, with
 * the config file that sets up Hot Updater for it: an Expo CNG project's
 * Expo config, or a One app's vite config. Null otherwise.
 */
export function prebuildConfig(
  cwd = getCwd(),
): { framework: "expo" | "one"; file: string } | null {
  const expoFile = expoConfigFile(cwd);
  if (expoFile !== null) return { framework: "expo", file: expoFile };
  return isOne(cwd) ? { framework: "one", file: "vite.config.ts" } : null;
}

/**
 * What the framework's config sets up for Hot Updater, as the build adapter
 * reads it: the `@hot-updater/expo` config plugin, or One's
 * `hotUpdaterPatches`. Its prebuild writes a channel only when the config
 * lists it, and a trust-anchor file only when it sets `publicKeyPath`. Null
 * when the adapter can't say.
 */
const readHotUpdaterSetup = async (
  cwd: string,
  config: Pick<ConfigResponse, "build">,
): Promise<{ listed: boolean; publicKeyPath: string | null } | null> => {
  try {
    const adapter = await config.build({ cwd });
    const values = await adapter.nativeBuild?.getNativeProjectValues?.({
      platform: "ios",
    });
    return values === undefined
      ? null
      : {
          listed: values.channel !== undefined,
          publicKeyPath: values.publicKeyPath ?? null,
        };
  } catch {
    return null;
  }
};

const PREBUILD_MESSAGES = {
  expo: {
    command: "npx expo prebuild",
    regenerates: [
      "Expo CNG project: npx expo prebuild regenerates the native files.",
      "Configure the @hot-updater/expo plugin in app.json or app.config.*:",
    ],
    entry: '"plugins": [["@hot-updater/expo", { "channel": "production" }]]',
    removesKey:
      "Expo CNG project: npx expo prebuild removes this key. Export it with --output and set publicKeyPath in the @hot-updater/expo plugin:",
    keyEntry: [
      '"plugins": [["@hot-updater/expo", {',
      '  "channel": "production",',
      '  "publicKeyPath": "./keys/public-key.pem"',
      "}]]",
    ],
  },
  one: {
    command: "npx one prebuild",
    regenerates: [
      "One app: npx one prebuild regenerates the native files.",
      "Add hotUpdaterPatches from @hot-updater/one/patches to native.app.patches in vite.config.ts:",
    ],
    entry: 'patches: hotUpdaterPatches({ channel: "production" })',
    removesKey:
      "One app: npx one prebuild removes this key. Export it with --output and set publicKeyPath in hotUpdaterPatches:",
    keyEntry: [
      "patches: hotUpdaterPatches({",
      '  channel: "production",',
      '  publicKeyPath: "./keys/public-key.pem",',
      "})",
    ],
  },
} as const;

/**
 * Warns a project whose prebuild generates its native folders when its config
 * doesn't set up Hot Updater, which the prebuild needs to keep Hot Updater's
 * native setup: an Expo CNG project without the `@hot-updater/expo` config
 * plugin, or a One app without `hotUpdaterPatches`. With `publicKey`, before a
 * command writes the signing public key into the native files, it warns as
 * well when the setup sets no `publicKeyPath`: prebuild then removes that
 * key. Call this once at the start of commands that use native parsers.
 * Returns null outside such a project, else the prebuild command and the
 * `publicKeyPath` the setup sets, if any.
 */
export async function warnIfPrebuildGenerated({
  cwd = getCwd(),
  config,
  publicKey = false,
}: {
  cwd?: string;
  config?: Pick<ConfigResponse, "build">;
  publicKey?: boolean;
} = {}): Promise<{ command: string; publicKeyPath: string | null } | null> {
  const prebuild = prebuildConfig(cwd);
  if (prebuild === null) {
    return null;
  }
  const messages = PREBUILD_MESSAGES[prebuild.framework];
  const setup = await readHotUpdaterSetup(
    cwd,
    config ?? (await loadConfig(null)),
  );

  // Each entry prints on its own line: a warning reads a JSON value in it as
  // a provider's error body and prints only the strings inside.
  if (publicKey) {
    const publicKeyPath = setup?.listed ? setup.publicKeyPath : null;
    if (publicKeyPath) return { command: messages.command, publicKeyPath };
    p.log.warn(messages.removesKey);
    // Short lines: messages wrap at the terminal's width.
    p.log.message(messages.keyEntry.join("\n"));
    return { command: messages.command, publicKeyPath: null };
  }
  const status = {
    command: messages.command,
    publicKeyPath: setup?.publicKeyPath ?? null,
  };
  if (setup?.listed) return status;

  p.log.warn(messages.regenerates.join("\n"));
  p.log.message(messages.entry);
  return status;
}
