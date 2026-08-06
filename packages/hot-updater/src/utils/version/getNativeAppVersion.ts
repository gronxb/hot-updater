import type { Platform } from "@hot-updater/core";

import { getAndroidVersion } from "./getAndroidVersion";
import { getIOSVersion } from "./getIOSVersion";

export const getNativeAppVersion = async (
  platform: Platform,
): Promise<string | null> => {
  switch (platform) {
    case "ios":
      // Info.plist first, project.pbxproj as a fallback.
      //
      // CFBundleShortVersionString is the version the built app actually
      // reports, so it is the more correct source (#84). It is also far cheaper:
      // reading Info.plist is a small file read, whereas the pbxproj parser is
      // synchronous and blocks the event loop for the length of the parse. On a
      // large project.pbxproj that can take minutes, and `deploy` calls this
      // after the bundle is already uploaded, purely to fill the informational
      // `metadata.app_version` field on the bundle record.
      return getIOSVersion({ parser: ["info-plist", "xcodeproj"] });
    case "android":
      return getAndroidVersion({ parser: "app-build-gradle" });
    default:
      return null;
  }
};
