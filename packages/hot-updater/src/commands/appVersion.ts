import { p } from "@hot-updater/cli-tools";

import { ui } from "../utils/cli-ui";
import { getNativeAppVersion } from "../utils/version/getNativeAppVersion";

export interface AppVersionOptions {
  json?: boolean;
}

export interface AppVersionResult {
  android: string | null;
  ios: string | null;
}

export const readAppVersions = async (): Promise<AppVersionResult> => {
  const [androidVersion, iosVersion] = await Promise.all([
    getNativeAppVersion("android"),
    getNativeAppVersion("ios"),
  ]);

  return {
    android: androidVersion,
    ios: iosVersion,
  };
};

export const handleAppVersion = async (
  options: AppVersionOptions = {},
): Promise<void> => {
  const versions = await readAppVersions();

  if (options.json) {
    console.log(JSON.stringify(versions, null, 2));
    return;
  }

  p.log.message(
    ui.block("App version", [
      ui.kv("Android", ui.version(versions.android)),
      ui.kv("iOS", ui.version(versions.ios)),
    ]),
  );
};
