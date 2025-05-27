import { merge } from "es-toolkit";
import { AndroidConfigParser } from "./configParser/androidParser";
import { IosConfigParser } from "./configParser/iosParser";

const DEFAULT_CHANNEL = "production";

const setAndroidChannel = async (
  channel: string,
  options?: { flavor?: string },
): Promise<{ path: string }> => {
  const androidParser = new AndroidConfigParser();
  return await androidParser.set("HOT_UPDATER_CHANNEL", channel, options);
};

const setIosChannel = async (
  channel: string,
  options?: { flavor?: string },
): Promise<{ path: string }> => {
  const iosParser = new IosConfigParser();
  return await iosParser.set("HOT_UPDATER_CHANNEL", channel, options);
};

export const setChannel = async (
  platform: "android" | "ios",
  channel: string,
  options?: { flavor?: string },
): Promise<{ path: string }> => {
  switch (platform) {
    case "android":
      return await setAndroidChannel(channel, options);
    case "ios":
      return await setIosChannel(channel, options);
  }
};

const getAndroidChannel = async (): Promise<{
  default: string;
  [flavor: string]: string | undefined;
}> => {
  const androidParser = new AndroidConfigParser();
  return merge(
    {
      default: DEFAULT_CHANNEL,
    },
    await androidParser.get("HOT_UPDATER_CHANNEL"),
  );
};

const getIosChannel = async (): Promise<{
  default: string;
  [flavor: string]: string | undefined;
}> => {
  const iosParser = new IosConfigParser();
  return merge(
    {
      default: DEFAULT_CHANNEL,
    },
    await iosParser.get("HOT_UPDATER_CHANNEL"),
  );
};

export const getChannel = async (
  platform: "android" | "ios",
): Promise<{
  default: string;
  [flavor: string]: string | undefined;
}> => {
  switch (platform) {
    case "android":
      return await getAndroidChannel();
    case "ios":
      return await getIosChannel();
  }
  return { default: DEFAULT_CHANNEL };
};
