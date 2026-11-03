import fs from "node:fs";
import path from "node:path";

/**
 * The lowest Expo SDK Hot Updater supports, the floor of `@hot-updater/expo`'s
 * `expo` peer range. doctor, the config plugin and the build adapter read it.
 */
export const MINIMUM_EXPO_SDK = 55;

/** The command that moves a project to the minimum Expo SDK. */
export const EXPO_SDK_UPGRADE_COMMAND = `npx expo install expo@^${MINIMUM_EXPO_SDK}.0.0 --fix`;

export interface ExpoSdk {
  /** The SDK's major version. */
  readonly sdk: number;
  /** The installed version, or the range's lowest when Expo isn't installed. */
  readonly version: string;
  readonly installed: boolean;
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
};

/**
 * The `expo` a build in `cwd` loads: the nearest `node_modules/expo` up from
 * it, as Node resolves a package. `NODE_PATH` isn't read, since package
 * managers point it at a store that isn't the project's.
 */
const installedExpoVersion = (cwd: string): string | null => {
  let dir = path.resolve(cwd);
  while (true) {
    const manifest = readJson<{ version?: string }>(
      path.join(dir, "node_modules", "expo", "package.json"),
    );
    if (manifest?.version) return manifest.version;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

/**
 * The lowest version a declared range allows, for an exact version, `^`, `~`,
 * `>=`, `=` or an x-range. Null for anything else, such as `catalog:sdk55`,
 * `workspace:*`, `latest` or a union, whose digits name no version.
 */
const lowestOfRange = (range: string): string | null => {
  const match =
    /^\s*(?:\^|~|>=|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?\s*$/u.exec(
      range,
    );
  if (!match) return null;
  const part = (value: string | undefined) =>
    value === undefined || value === "x" || value === "*" ? "0" : value;
  return `${match[1]}.${part(match[2])}.${part(match[3])}`;
};

/**
 * A project's Expo SDK: the installed `expo` the project resolves, else the
 * lowest version its declared range allows. Null without either.
 */
export const readExpoSdk = (cwd: string): ExpoSdk | null => {
  const installed = installedExpoVersion(cwd);
  if (installed !== null) {
    const sdk = Number.parseInt(installed, 10);
    return Number.isNaN(sdk)
      ? null
      : { sdk, version: installed, installed: true };
  }
  const manifest = readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(path.join(cwd, "package.json"));
  const declared =
    manifest?.dependencies?.["expo"] ?? manifest?.devDependencies?.["expo"];
  const lowest = declared === undefined ? null : lowestOfRange(declared);
  if (lowest === null) return null;
  return {
    sdk: Number.parseInt(lowest, 10),
    version: lowest,
    installed: false,
  };
};

/**
 * Refuses a project whose installed Expo is below the minimum SDK. A project
 * without Expo installed passes: nothing could build it yet.
 */
export const assertSupportedExpoSdk = (cwd: string): void => {
  const expo = readExpoSdk(cwd);
  if (expo?.installed && expo.sdk < MINIMUM_EXPO_SDK) {
    throw new Error(
      `Hot Updater requires Expo SDK ${MINIMUM_EXPO_SDK} or later. Run:\n${EXPO_SDK_UPGRADE_COMMAND}`,
    );
  }
};
