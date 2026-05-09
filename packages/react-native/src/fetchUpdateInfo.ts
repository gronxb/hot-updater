import type { AppUpdateInfo } from "@hot-updater/core";

import { task, withRetry, withTimeout } from "./utils/task";

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

export const fetchUpdateInfo = async ({
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

  const getUpdateResponse = task<Response | undefined>(
    (signal?: AbortSignal) => {
      return fetch(url, {
        signal,
        headers,
      });
    },
  );

  const response = await getUpdateResponse
    .pipe(
      withTimeout(requestTimeout),
      withRetry(1, (response) => !response),
    )
    .run();

  return parseUpdateInfo(requireResponse(response));
};
