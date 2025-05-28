import { AndroidConfigParser } from "./configParser/androidParser";
import { IosConfigParser } from "./configParser/iosParser";

const DEFAULT_CHANNEL = "production";

const setAndroidChannel = async (
  channel: string,
): Promise<{ path: string }> => {
  const androidParser = new AndroidConfigParser();
  return await androidParser.set("hot_updater_channel", channel);
};

const getAndroidChannel = async (): Promise<string> => {
  const androidParser = new AndroidConfigParser();
  if (!androidParser.exists()) {
    throw new Error("android/app/src/main/res/values/strings.xml not found");
  }
  return (await androidParser.get("hot_updater_channel")) ?? DEFAULT_CHANNEL;
};

const setIosChannel = async (channel: string): Promise<{ path: string }> => {
  const iosParser = new IosConfigParser();
  return await iosParser.set("HOT_UPDATER_CHANNEL", channel);
};

const getIosChannel = async (): Promise<string> => {
  const iosParser = new IosConfigParser();
  if (!iosParser.exists()) {
    throw new Error("Info.plist not found");
  }
  return (await iosParser.get("HOT_UPDATER_CHANNEL")) ?? DEFAULT_CHANNEL;
};

export const setChannel = async (
  platform: "android" | "ios",
  channel: string,
): Promise<{ path: string }> => {
  switch (platform) {
    case "android":
      return await setAndroidChannel(channel);
    case "ios":
      return await setIosChannel(channel);
  }
};
export const getChannel = async (
  platform: "android" | "ios",
): Promise<string> => {
  switch (platform) {
    case "android":
      return await getAndroidChannel();
    case "ios":
      return await getIosChannel();
  }
};
