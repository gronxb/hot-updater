import { getAndroidVersion } from "@/utils/version/getAndroidVersion";
import { getIOSVersion } from "@/utils/version/getIOSVersion";
import type { Platform } from "@hot-updater/plugin-core";
import semverValid from "semver/ranges/valid";

export const getDefaultTargetAppVersion = async (
  platform: Platform,
): Promise<string | null> => {
  let version: string | null = null;

  switch (platform) {
    case "ios":
      version = await getIOSVersion({ strategy: "info-plist" });
      break;
    case "android":
      version = await getAndroidVersion({ strategy: "app-build-gradle" });
      break;
  }

  if (!version) return null;

  const isAcceptableFormat = /^\d+\.\d+$/.test(version) || semverValid(version);
  if (!isAcceptableFormat) return null;

  // If version only has one dot (e.g. 1.0), append .x
  const dotCount = version.split(".").length - 1;
  if (dotCount === 1) {
    version = `${version}.x`;
  }

  return version;
};
