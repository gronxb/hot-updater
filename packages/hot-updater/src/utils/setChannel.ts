import { loadConfig } from "@hot-updater/plugin-core";
import { merge } from "es-toolkit";
import { AndroidConfigParser } from "./configParser/androidParser";
import { IosConfigParser } from "./configParser/iosParser";

const DEFAULT_CHANNEL = "production";

const setAndroidChannel = async (
  channel: string,
): Promise<{ path: string | null }> => {
  const config = await loadConfig(null);
  const customPaths = (config as any).platform?.android?.stringResourcePaths;
  const androidParser = new AndroidConfigParser(customPaths);
  return await androidParser.set("hot_updater_channel", channel);
};

const getAndroidChannel = async (): Promise<{
  value: string;
  path: string;
}> => {
  const config = await loadConfig(null);
  const customPaths = (config as any).platform?.android?.stringResourcePaths;
  const androidParser = new AndroidConfigParser(customPaths);
  if (!(await androidParser.exists())) {
    throw new Error("No Android strings.xml files found");
  }
  return merge(
    { value: DEFAULT_CHANNEL },
    await androidParser.get("hot_updater_channel"),
  );
};

const setIosChannel = async (
  channel: string,
): Promise<{ path: string | null }> => {
  const config = await loadConfig(null);
  const customPaths = (config as any).platform?.ios?.infoPlistPaths;
  const iosParser = new IosConfigParser(customPaths);
  return await iosParser.set("HOT_UPDATER_CHANNEL", channel);
};

const getIosChannel = async (): Promise<{
  value: string;
  path: string | null;
}> => {
  const config = await loadConfig(null);
  const customPaths = (config as any).platform?.ios?.infoPlistPaths;
  const iosParser = new IosConfigParser(customPaths);
  if (!(await iosParser.exists())) {
    throw new Error("No iOS Info.plist files found");
  }
  return merge(
    { value: DEFAULT_CHANNEL },
    await iosParser.get("HOT_UPDATER_CHANNEL"),
  );
};

export const setChannel = async (
  platform: "android" | "ios",
  channel: string,
): Promise<{ path: string | null }> => {
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
  path: string | null;
}> => {
  switch (platform) {
    case "android":
      return await getAndroidChannel();
    case "ios":
      return await getIosChannel();
  }
};
