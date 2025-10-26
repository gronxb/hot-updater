import type {
  AppUpdateInfo,
  UpdateBundleParams,
  UpdateStrategy,
} from "@hot-updater/core";

export type UpdateSource =
  | string
  | ((params: UpdateBundleParams) => Promise<AppUpdateInfo | null>)
  | ((params: UpdateBundleParams) => string);

function buildRequestHeaders(
  params: UpdateBundleParams,
  requestHeaders?: Record<string, string>,
): Record<string, string> {
  const updateStrategy: UpdateStrategy = params.fingerprintHash
    ? "fingerprint"
    : "appVersion";

  return {
    "Content-Type": "application/json",
    "x-app-platform": params.platform,
    "x-bundle-id": params.bundleId,
    ...(updateStrategy === "fingerprint"
      ? { "x-fingerprint-hash": params.fingerprintHash! }
      : { "x-app-version": params.appVersion }),
    ...(params.minBundleId && { "x-min-bundle-id": params.minBundleId }),
    ...(params.channel && { "x-channel": params.channel }),
    ...requestHeaders,
  };
}

async function resolveSource(
  source: UpdateSource,
  params: UpdateBundleParams,
): Promise<{ url: string } | { info: AppUpdateInfo | null }> {
  if (typeof source !== "function") {
    return { url: source };
  }
  const result = source(params);
  if (typeof result === "string") {
    return { url: result };
  }
  return { info: await result };
}

export const fetchUpdateInfo = async ({
  source,
  params,
  requestHeaders,
  onError,
  requestTimeout = 5000,
}: {
  source: UpdateSource;
  params: UpdateBundleParams;
  requestHeaders?: Record<string, string>;
  onError?: (error: Error) => void;
  requestTimeout?: number;
}): Promise<AppUpdateInfo | null> => {
  try {
    const resolvedSource = await resolveSource(source, params);
    if ("info" in resolvedSource) {
      return resolvedSource.info;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, requestTimeout);

    const headers = buildRequestHeaders(params, requestHeaders);

    const response = await fetch(resolvedSource.url, {
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
    } else {
      onError?.(error as Error);
    }
    return null;
  }
};
