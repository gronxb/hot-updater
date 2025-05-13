import type { AppUpdateInfo, GetBundlesArgs } from "@hot-updater/core";

export type UpdateSource = string | (() => Promise<AppUpdateInfo | null>);

export const fetchUpdateInfo = async (
  source: UpdateSource,
  args: GetBundlesArgs,
  requestHeaders?: Record<string, string>,
  onError?: (error: Error) => void,
  requestTimeout = 5000,
): Promise<AppUpdateInfo | null> => {
  if (typeof source === "function") {
    return source();
  }

  const appVersion = "appVersion" in args ? args.appVersion : undefined;
  const fingerprint = "fingerprint" in args ? args.fingerprint : undefined;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, requestTimeout);

  try {
    if (!appVersion && !fingerprint) {
      throw new Error("appVersion or fingerprint is required");
    }
    if (appVersion && fingerprint) {
      throw new Error("appVersion and fingerprint cannot both be provided");
    }

    const response = await fetch(source, {
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-app-platform": args.platform,
        "x-bundle-id": args.bundleId,
        ...(args.minBundleId ? { "x-min-bundle-id": args.minBundleId } : {}),
        ...(args.channel ? { "x-channel": args.channel } : {}),
        ...(appVersion ? { "x-app-version": appVersion } : {}),
        ...(fingerprint ? { "x-fingerprint": fingerprint } : {}),
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
