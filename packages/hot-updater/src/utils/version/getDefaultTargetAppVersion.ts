import type { Platform } from "@hot-updater/plugin-core";
import { normalizeRange } from "verkit";

import { getAndroidVersion } from "./getAndroidVersion";
import { getIOSVersion } from "./getIOSVersion";

export const getDefaultTargetAppVersion = async (
  platform: Platform,
): Promise<string | null> => {
  let version: string | null = null;

  switch (platform) {
    case "ios":
      // Mirror getNativeAppVersion: Info.plist first, project.pbxproj as a
      // fallback. The React Native template ships Info.plist with
      // CFBundleShortVersionString set to "$(MARKETING_VERSION)", which the
      // plist parser cannot resolve, so the real version only lives in
      // project.pbxproj for most projects.
      version = await getIOSVersion({ parser: ["info-plist", "xcodeproj"] });
      break;
    case "android":
      version = await getAndroidVersion({ parser: "app-build-gradle" });
      break;
  }

  if (!version) return null;

  const isAcceptableFormat =
    /^\d+\.\d+$/.test(version) || normalizeRange(version);
  if (!isAcceptableFormat) return null;

  // If version only has one dot (e.g. 1.0), append .x
  const dotCount = version.split(".").length - 1;
  if (dotCount === 1) {
    version = `${version}.x`;
  }

  return version;
};
