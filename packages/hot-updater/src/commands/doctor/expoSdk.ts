import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { ConfigResponse } from "@hot-updater/cli-tools";

import type { NativeCheckIssue } from "./issues";

/**
 * The lowest Expo SDK Hot Updater supports, the floor of `@hot-updater/expo`'s
 * `expo` peer range.
 */
export const MINIMUM_EXPO_SDK = 55;

const majorOf = (version: string | undefined): number | null => {
  const major = /(\d+)/u.exec(version ?? "");
  return major ? Number(major[1]) : null;
};

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
};

/**
 * The major version of a project's Expo SDK, or null without one: what's
 * installed, else what `package.json` declares, as a range such as `catalog:`
 * or `latest` names no version.
 */
export const expoSdkOf = (cwd: string): number | null => {
  try {
    const installed = readJson<{ version?: string }>(
      createRequire(path.join(cwd, "package.json")).resolve(
        "expo/package.json",
      ),
    );
    const sdk = majorOf(installed?.version);
    if (sdk !== null) return sdk;
  } catch {
    // Not installed: the declared range is all there is.
  }
  const manifest = readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(path.join(cwd, "package.json"));
  return majorOf(
    manifest?.dependencies?.["expo"] ?? manifest?.devDependencies?.["expo"],
  );
};

/** An Expo project below the SDK Hot Updater supports. */
export const checkExpoSdk = async (
  config: ConfigResponse,
  cwd: string,
): Promise<NativeCheckIssue[]> => {
  const adapter = await Promise.resolve(config.build({ cwd }))
    .then(({ name }) => name)
    .catch(() => undefined);
  if (adapter !== "expo") return [];
  const sdk = expoSdkOf(cwd);
  if (sdk === null || sdk >= MINIMUM_EXPO_SDK) return [];
  const command = `npx expo install expo@^${MINIMUM_EXPO_SDK}.0.0 --fix`;
  return [
    {
      type: "error",
      platform: "project",
      code: "EXPO_SDK_UNSUPPORTED",
      message: `Hot Updater needs Expo SDK ${MINIMUM_EXPO_SDK} or later. This project uses SDK ${sdk}.`,
      resolution: `Run \`${command}\`.`,
      commands: [command],
    },
  ];
};
