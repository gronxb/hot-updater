import type { AppUpdateInfo, GetBundlesArgs } from "@hot-updater/core";

export const fetchUpdateInfo = async (
  source: string,
  { appVersion, bundleId, platform, minBundleId, channel }: GetBundlesArgs,
  requestHeaders?: Record<string, string>,
): Promise<AppUpdateInfo | null> => {
  try {
    return fetch(source, {
      headers: {
        "x-app-platform": platform,
        "x-app-version": appVersion,
        "x-bundle-id": bundleId,
        ...(minBundleId ? { "x-min-bundle-id": minBundleId } : {}),
        ...(channel ? { "x-channel": channel } : {}),
        ...requestHeaders,
      },
    }).then((res) => (res.status === 200 ? res.json() : null));
  } catch {
    return null;
  }
};
