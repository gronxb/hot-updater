import type { AppUpdateInfo } from "@hot-updater/core";

export const fetchUpdateInfo = async ({
  url,
  requestHeaders,
  requestTimeout = 5000,
}: {
  url: string;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
}): Promise<AppUpdateInfo | null> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, requestTimeout);

  try {
    const headers = {
      "Content-Type": "application/json",
      ...requestHeaders,
    };

    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });

    if (response.status !== 200) {
      throw new Error(response.statusText);
    }
    return response.json();
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};
