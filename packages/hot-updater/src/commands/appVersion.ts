import { p } from "@hot-updater/cli-tools";

import { ui } from "../utils/cli-ui";
import {
  formatAppVersionCandidates,
  isAmbiguousAppVersion,
  type ResolvedAppVersion,
} from "../utils/version/appVersionCandidates";
import { resolveNativeAppVersion } from "../utils/version/getNativeAppVersion";

export interface AppVersionOptions {
  json?: boolean;
}

export interface AppVersionResult {
  android: string | null;
  ios: string | null;
}

const readAppVersions = async () => {
  const [android, ios] = await Promise.all([
    resolveNativeAppVersion("android"),
    resolveNativeAppVersion("ios"),
  ]);
  return { android, ios };
};

const formatVersion = (resolved: ResolvedAppVersion) =>
  isAmbiguousAppVersion(resolved)
    ? ui.warning(
        `several (${formatAppVersionCandidates(resolved.candidates)}); deploy needs -t`,
      )
    : ui.version(resolved.version);

export const handleAppVersion = async (
  options: AppVersionOptions = {},
): Promise<void> => {
  const versions = await readAppVersions();

  if (options.json) {
    // null when no version, or several: see the human-readable output.
    console.log(
      JSON.stringify(
        {
          android: versions.android.version,
          ios: versions.ios.version,
        } satisfies AppVersionResult,
        null,
        2,
      ),
    );
    return;
  }

  p.log.message(
    ui.block("App version", [
      ui.kv("Android", formatVersion(versions.android)),
      ui.kv("iOS", formatVersion(versions.ios)),
    ]),
  );
};
