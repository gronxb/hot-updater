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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, requestTimeout);

  try {
    let headers: Record<string, string> = {};

    switch (args._updateStrategy) {
      case "fingerprint":
        headers = {
          "Content-Type": "application/json",
          "x-app-platform": args.platform,
          "x-bundle-id": args.bundleId,
          "x-fingerprint-hash": args.fingerprintHash,
          ...(args.minBundleId ? { "x-min-bundle-id": args.minBundleId } : {}),
          ...(args.channel ? { "x-channel": args.channel } : {}),
          ...requestHeaders,
        };
        break;
      case "appVersion":
        headers = {
          "Content-Type": "application/json",
          "x-app-platform": args.platform,
          "x-bundle-id": args.bundleId,
          "x-app-version": args.appVersion,
          ...(args.minBundleId ? { "x-min-bundle-id": args.minBundleId } : {}),
          ...(args.channel ? { "x-channel": args.channel } : {}),
          ...requestHeaders,
        };
        break;
      default:
        throw new Error("Invalid update strategy");
    }

    const response = await fetch(source, {
      signal: controller.signal,
      headers,
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
