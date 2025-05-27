import { AndroidConfigParser, IosConfigParser } from "./configParser";

const DEFAULT_CHANNEL = "production";

const setAndroidChannel = async (
  channel: string,
): Promise<{ path: string }> => {
  const androidParser = new AndroidConfigParser();
  return await androidParser.set("HOT_UPDATER_CHANNEL", channel);
};

const setIosChannel = async (channel: string): Promise<{ path: string }> => {
  const iosParser = new IosConfigParser();
  return await iosParser.set("HOT_UPDATER_CHANNEL", channel);
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

const getAndroidChannel = async (): Promise<string> => {
  const androidParser = new AndroidConfigParser();
  return (await androidParser.get("HOT_UPDATER_CHANNEL")) ?? DEFAULT_CHANNEL;
};

const getIosChannel = async (): Promise<string> => {
  const iosParser = new IosConfigParser();
  return (await iosParser.get("HOT_UPDATER_CHANNEL")) ?? DEFAULT_CHANNEL;
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
  return DEFAULT_CHANNEL;
};
