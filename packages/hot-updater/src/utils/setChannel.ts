import { merge } from "es-toolkit";
import { AndroidConfigParser } from "./configParser/androidParser";
import { IosConfigParser } from "./configParser/iosParser";

const DEFAULT_CHANNEL = "production";

const setAndroidChannel = async (
  channel: string,
): Promise<{ path: string | null }> => {
  const androidParser = new AndroidConfigParser();
  return await androidParser.set("hot_updater_channel", channel);
};

const getAndroidChannel = async (): Promise<{
  value: string;
  path: string;
}> => {
  const androidParser = new AndroidConfigParser();
  if (!androidParser.exists()) {
    throw new Error("android/app/src/main/res/values/strings.xml not found");
  }
  return merge(
    { value: DEFAULT_CHANNEL },
    await androidParser.get("hot_updater_channel"),
  );
};

const setIosChannel = async (
  channel: string,
): Promise<{ path: string | null }> => {
  const iosParser = new IosConfigParser();
  return await iosParser.set("HOT_UPDATER_CHANNEL", channel);
};

const getIosChannel = async (): Promise<{
  value: string;
  path: string | null;
}> => {
  const iosParser = new IosConfigParser();
  if (!iosParser.exists()) {
    throw new Error("Info.plist not found");
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
