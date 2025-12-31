import type { AppUpdateInfo } from "@hot-updater/core";

export const fetchUpdateInfo = async ({
  url,
  requestHeaders,
  onError,
  requestTimeout = 5000,
}: {
  url: string;
  requestHeaders?: Record<string, string>;
  onError?: (error: Error) => void;
  requestTimeout?: number;
}): Promise<AppUpdateInfo | null> => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, requestTimeout);

    const headers = {
      "Content-Type": "application/json",
      ...requestHeaders,
    };

    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeoutId);

    if (response.status !== 200) {
      throw new Error(response.statusText);
    }
    return response.json();
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      onError?.(new Error("Request timed out"));
    } else {
      onError?.(error as Error);
    }
    return null;
  }
};
