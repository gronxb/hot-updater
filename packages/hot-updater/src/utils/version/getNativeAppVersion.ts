import type { Platform } from "@hot-updater/core";
import { getAndroidVersion } from "./getAndroidVersion";
import { getIOSVersion } from "./getIOSVersion";

export const getNativeAppVersion = async (
  platform: Platform,
): Promise<string | null> => {
  switch (platform) {
    case "ios":
      return getIOSVersion({ parser: ["xcodeproj", "info-plist"] });
    case "android":
      return getAndroidVersion({ parser: "app-build-gradle" });
    default:
      return null;
  }
};
