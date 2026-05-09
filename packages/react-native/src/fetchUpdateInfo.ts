import type { AppUpdateInfo } from "@hot-updater/core";

const requireResponse = (response: Response | undefined) => {
  if (!response) {
    throw new Error("Fetch returned no response");
  }
  return response;
};

const parseUpdateInfo = (response: Response): Promise<AppUpdateInfo | null> => {
  if (response.status !== 200) {
    throw new Error(response.statusText);
  }
  return response.json();
};

export const fetchUpdateInfo = ({
  url,
  requestHeaders,
  requestTimeout = 5000,
}: {
  url: string;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
}): Promise<AppUpdateInfo | null> => {
  const headers = {
    "Content-Type": "application/json",
    ...requestHeaders,
  };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, requestTimeout);

  return fetch(url, {
    signal: controller.signal,
    headers,
  })
    .then(requireResponse)
    .then(parseUpdateInfo)
    .catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request timed out");
      }
      throw error;
    })
    .finally(() => {
      clearTimeout(timeoutId);
    });
};
