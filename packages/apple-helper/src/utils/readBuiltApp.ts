import path from "path";

import { execa } from "execa";

const readInfoValue = async (infoPlist: string, key: string) => {
  const { stdout, exitCode } = await execa(
    "plutil",
    ["-extract", key, "raw", "-o", "-", infoPlist],
    { reject: false },
  );
  return exitCode === 0 && stdout.trim() ? stdout.trim() : null;
};

/**
 * What the built `.app` reports at runtime, from its Info.plist: the
 * `CFBundleShortVersionString`, `CFBundleVersion` (the build number) and
 * `HOT_UPDATER_CHANNEL` the build settings,
 * an `xcconfig` and `extraParams` expanded.
 */
export const readBuiltApp = async (appPath: string) => {
  const infoPlist = path.join(appPath, "Info.plist");
  const [appVersion, channel, buildNumber] = await Promise.all([
    readInfoValue(infoPlist, "CFBundleShortVersionString"),
    readInfoValue(infoPlist, "HOT_UPDATER_CHANNEL"),
    readInfoValue(infoPlist, "CFBundleVersion"),
  ]);
  return { appVersion, channel, buildNumber };
};
