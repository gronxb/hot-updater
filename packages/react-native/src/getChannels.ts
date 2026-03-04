import { HotUpdaterError } from "./error";

export interface GetChannelsOptions {
  requestHeaders?: Record<string, string>;
  onError?: (error: Error) => void;
  /**
   * The timeout duration for the request.
   * @default 5000
   */
  requestTimeout?: number;
}

export interface InternalGetChannelsOptions extends GetChannelsOptions {
  baseURL: string;
}

/**
 * Fetches the list of available channels from the update server.
 *
 * @param options Configuration options for the request
 * @returns Promise resolving to an array of channel strings, or null on error
 */
export async function getChannels(
  options: InternalGetChannelsOptions,
): Promise<string[] | null> {
  const { baseURL, requestHeaders, requestTimeout = 5000, onError } = options;

  const channelsUrl = `${baseURL}/api/bundles/channels`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, requestTimeout);

  const headers = {
    "Content-Type": "application/json",
    ...requestHeaders,
  };

  try {
    const response = await fetch(channelsUrl, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    if (response.status !== 200) {
      throw new HotUpdaterError(
        `Failed to fetch channels: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { channels: string[] };
    return data.channels ?? [];
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      onError?.(new HotUpdaterError("Request timed out"));
    } else {
      onError?.(error as Error);
    }
    return null;
  }
}
