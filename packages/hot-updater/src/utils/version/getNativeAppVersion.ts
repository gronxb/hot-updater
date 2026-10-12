import type { Platform } from "@hot-updater/protocol";

import type { ResolvedAppVersion } from "./appVersionCandidates";
import {
  type AndroidAppVersionScope,
  resolveAndroidAppVersion,
} from "./getAndroidVersion";
import { type IOSAppVersionScope, resolveIOSAppVersion } from "./getIOSVersion";

/** The native build scheme to read the version for, per platform. */
export interface NativeAppVersionScope {
  ios?: IOSAppVersionScope;
  android?: AndroidAppVersionScope;
}

/**
 * The version the native project builds, with every place it is declared.
 * A project that builds several apps (Xcode targets, product flavors) with
 * different versions resolves to null unless `scope` names the one built.
 */
export const resolveNativeAppVersion = async (
  platform: Platform,
  scope: NativeAppVersionScope = {},
): Promise<ResolvedAppVersion> => {
  switch (platform) {
    case "ios":
      return resolveIOSAppVersion(scope.ios);
    case "android":
      return resolveAndroidAppVersion(scope.android);
    default:
      return { version: null, candidates: [] };
  }
};

export const getNativeAppVersion = async (
  platform: Platform,
  scope?: NativeAppVersionScope,
): Promise<string | null> =>
  (await resolveNativeAppVersion(platform, scope)).version;
