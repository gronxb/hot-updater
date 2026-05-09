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
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const headers = {
      "Content-Type": "application/json",
      ...requestHeaders,
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("Request timed out"));
      }, requestTimeout);
    });

    const response = await Promise.race([
      fetch(url, {
        headers,
      }),
      timeoutPromise,
    ]);

    if (!response) {
      throw new Error("Fetch returned no response");
    }

    if (response.status !== 200) {
      throw new Error(response.statusText);
    }
    return response.json();
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};
