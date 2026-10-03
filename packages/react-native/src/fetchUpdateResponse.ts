import type { UpdateHttpResponse } from "@hot-updater/protocol";

export interface UpdateRequest {
  readonly url: string;
  readonly resource: UpdateHttpResponse["resource"];
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
  readonly onResponse?: (response: UpdateHttpResponse) => void;
}

/** Read once for parsing and diagnostics, under the same request timeout. */
export const fetchUpdateResponse = async ({
  url,
  resource,
  requestHeaders,
  requestTimeout = 5000,
  onResponse,
}: UpdateRequest): Promise<{ response: Response; body: string | null }> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), requestTimeout);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...requestHeaders },
      signal: controller.signal,
    });
    let body: string | null = null;
    try {
      body = await response.text();
    } catch (error) {
      // A broken error body must not hide an HTTP error already received.
      if (response.status === 200) throw error;
    } finally {
      onResponse?.({
        resource,
        // React Native URL implementations do not all expose pathname.
        path:
          url.replace(/^https?:\/\/[^/?#]*/i, "").split(/[?#]/, 1)[0] || "/",
        status: response.status,
        body,
        bodyTruncated: false,
      });
    }
    return { response, body };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};
