import type { AppUpdateInfo, GetBundlesArgs } from "@hot-updater/core";

export type UpdateSource = string | (() => Promise<AppUpdateInfo | null>);

export const fetchUpdateInfo = async (
  source: UpdateSource,
  { appVersion, bundleId, platform, minBundleId, channel }: GetBundlesArgs,
  requestHeaders?: Record<string, string>,
  onError?: (error: Error) => void,
  requestTimeout = 5000,
): Promise<AppUpdateInfo | null> => {
  if (typeof source === "function") {
    return source();
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, requestTimeout);

  try {
    const response = await fetch(source, {
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-app-platform": platform,
        "x-app-version": appVersion,
        "x-bundle-id": bundleId,
        ...(minBundleId ? { "x-min-bundle-id": minBundleId } : {}),
        ...(channel ? { "x-channel": channel } : {}),
        ...requestHeaders,
      },
    });

    clearTimeout(timeoutId);

    if (response.status !== 200) {
      throw new Error(response.statusText);
    }
    return response.json();
  } catch (error: any) {
    if (error.name === "AbortError") {
      onError?.(new Error("Request timed out"));
      return null;
    }
    onError?.(error as Error);
    return null;
  }
};
