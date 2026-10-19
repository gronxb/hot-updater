import fs from "fs";
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
 * The `HOT_UPDATER_CHANNEL` the app uses. A brownfield framework the app
 * embeds holds its own, which Hot Updater reads before the app's, so one
 * channel the embedded frameworks agree on is the app's.
 */
const readChannel = async (appPath: string) => {
  const frameworks = path.join(appPath, "Frameworks");
  const embedded = fs.existsSync(frameworks)
    ? await Promise.all(
        fs
          .readdirSync(frameworks)
          .filter((name) => name.endsWith(".framework"))
          .map((name) =>
            readInfoValue(
              path.join(frameworks, name, "Info.plist"),
              "HOT_UPDATER_CHANNEL",
            ),
          ),
      )
    : [];
  const channels = new Set(embedded.filter((channel) => channel !== null));
  if (channels.size === 1) {
    return [...channels][0]!;
  }
  return readInfoValue(path.join(appPath, "Info.plist"), "HOT_UPDATER_CHANNEL");
};

/**
 * What the built `.app` reports at runtime, from its Info.plist: the
 * `CFBundleShortVersionString` and `HOT_UPDATER_CHANNEL` the build settings,
 * an `xcconfig` and `extraParams` expanded.
 */
export const readBuiltApp = async (appPath: string) => {
  const [appVersion, channel] = await Promise.all([
    readInfoValue(
      path.join(appPath, "Info.plist"),
      "CFBundleShortVersionString",
    ),
    readChannel(appPath),
  ]);
  return { appVersion, channel };
};
