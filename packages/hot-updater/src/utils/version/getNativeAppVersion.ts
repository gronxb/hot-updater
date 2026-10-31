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
 * `baseVersion` is the version a build adapter's prebuild would write as the
 * app's own, read without writing it: Android's defaultConfig versionName,
 * which a product flavor's still overrides, and the iOS app's Info.plist.
 */
export const resolveNativeAppVersion = async (
  platform: Platform,
  scope: NativeAppVersionScope = {},
  baseVersion?: string,
): Promise<ResolvedAppVersion> => {
  switch (platform) {
    case "ios":
      return resolveIOSAppVersion(scope.ios, baseVersion);
    case "android":
      return resolveAndroidAppVersion(scope.android, baseVersion);
    default:
      return { version: null, candidates: [] };
  }
};

export const getNativeAppVersion = async (
  platform: Platform,
  scope?: NativeAppVersionScope,
): Promise<string | null> =>
  (await resolveNativeAppVersion(platform, scope)).version;
