import type { AppUpdateInfo, GetBundlesArgs } from "@hot-updater/core";

export const fetchUpdateInfo = async (
  source: string,
  { appVersion, bundleId, platform, minBundleId, channel }: GetBundlesArgs,
  requestHeaders?: Record<string, string>,
  onError?: (error: Error) => void,
): Promise<AppUpdateInfo | null> => {
  try {
    const response = await fetch(source, {
      headers: {
        "x-app-platform": platform,
        "x-app-version": appVersion,
        "x-bundle-id": bundleId,
        ...(minBundleId ? { "x-min-bundle-id": minBundleId } : {}),
        ...(channel ? { "x-channel": channel } : {}),
        ...requestHeaders,
      },
    });

    if (response.status !== 200) {
      throw new Error(response.statusText);
    }
    return response.json();
  } catch (error) {
    onError?.(error as Error);
    return null;
  }
};
