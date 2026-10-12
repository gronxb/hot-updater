import type { Platform } from "@hot-updater/plugin-core";
import { normalizeRange } from "verkit";

import type { ResolvedAppVersion } from "./appVersionCandidates";
import { resolveNativeAppVersion } from "./getNativeAppVersion";

/**
 * The target app version deploy defaults to, as a range. `version` is null
 * when the native files declare none, or several (see `candidates`).
 */
export const getDefaultTargetAppVersion = async (
  platform: Platform,
): Promise<ResolvedAppVersion> => {
  const resolved = await resolveNativeAppVersion(platform);
  let version = resolved.version;

  if (!version) return resolved;

  const isAcceptableFormat =
    /^\d+\.\d+$/.test(version) || normalizeRange(version);
  if (!isAcceptableFormat) return { ...resolved, version: null };

  // If version only has one dot (e.g. 1.0), append .x
  const dotCount = version.split(".").length - 1;
  if (dotCount === 1) {
    version = `${version}.x`;
  }

  return { ...resolved, version };
};
