import { loadConfig } from "@hot-updater/cli-tools";

import { AndroidConfigParser } from "./configParser/androidParser";
import { IosConfigParser } from "./configParser/iosParser";

const DEFAULT_CHANNEL = "production";

const setAndroidChannel = async (
  channel: string,
): Promise<{ paths: string[] }> => {
  const config = await loadConfig(null);
  const customPaths = config.platform.android.stringResourcePaths ?? [];
  const androidParser = new AndroidConfigParser(
    customPaths,
    config.platform.android.androidManifestPaths ?? [],
  );
  return await androidParser.set("hot_updater_channel", channel);
};

const getAndroidChannel = async (): Promise<{
  value: string;
  paths: string[];
}> => {
  const config = await loadConfig(null);
  const customPaths = config.platform.android.stringResourcePaths ?? [];
  const androidParser = new AndroidConfigParser(
    customPaths,
    config.platform.android.androidManifestPaths ?? [],
  );
  if (!(await androidParser.exists())) {
    throw new Error("No Android native config files found");
  }
  const { value, paths } = await androidParser.get("hot_updater_channel");
  return { value: value ?? DEFAULT_CHANNEL, paths };
};

const setIosChannel = async (channel: string): Promise<{ paths: string[] }> => {
  const config = await loadConfig(null);
  const customPaths = config.platform.ios.infoPlistPaths;
  const iosParser = new IosConfigParser(customPaths);
  return await iosParser.set("HOT_UPDATER_CHANNEL", channel);
};

const getIosChannel = async (): Promise<{
  value: string;
  paths: string[];
}> => {
  const config = await loadConfig(null);
  const customPaths = config.platform.ios.infoPlistPaths;
  const iosParser = new IosConfigParser(customPaths);
  if (!(await iosParser.exists())) {
    throw new Error("No iOS Info.plist files found");
  }
  const { value, paths } = await iosParser.get("HOT_UPDATER_CHANNEL");
  return { value: value ?? DEFAULT_CHANNEL, paths };
};

export const setChannel = async (
  platform: "android" | "ios",
  channel: string,
): Promise<{ paths: string[] }> => {
  switch (platform) {
    case "android":
      return await setAndroidChannel(channel);
    case "ios":
      return await setIosChannel(channel);
  }
};
export const getChannel = async (
  platform: "android" | "ios",
): Promise<{
  value: string;
  paths: string[];
}> => {
  switch (platform) {
    case "android":
      return await getAndroidChannel();
    case "ios":
      return await getIosChannel();
  }
};
