import type { UpdateHttpResponse } from "@hot-updater/protocol";
import { Platform } from "react-native";

export interface UpdateRequest {
  readonly url: string;
  readonly resource: UpdateHttpResponse["resource"];
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
  readonly onResponse?: (response: UpdateHttpResponse) => void;
}

/** What callers read from an update response. */
export interface UpdateResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
}

/** How long an update request may take when the app sets no `requestTimeout`. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

const abortError = () => {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
};

const parseResponseHeaders = (raw: string): UpdateResponse["headers"] => {
  const headers = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    const existing = headers.get(name);
    headers.set(name, existing === undefined ? value : `${existing}, ${value}`);
  }
  return { get: (name) => headers.get(name.toLowerCase()) ?? null };
};

/**
 * React Native's `fetch` resolves in a `setTimeout`, and Android runs no
 * JavaScript timer while the app is in the background. An update response
 * that arrived after the user left would reach the app only when they come
 * back, and native would download with links the server signed long before.
 * XMLHttpRequest answers from the network event itself.
 */
const requestWithoutTimers = (
  url: string,
  headers: Headers,
  signal: AbortSignal,
): Promise<{ response: UpdateResponse; body: string }> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    headers.forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.onload = () => {
      resolve({
        response: {
          status: xhr.status,
          statusText: xhr.statusText ?? "",
          headers: parseResponseHeaders(xhr.getAllResponseHeaders() ?? ""),
        },
        body: xhr.responseText,
      });
    };
    // The errors whatwg-fetch rejects with.
    xhr.onerror = () => reject(new TypeError("Network request failed"));
    xhr.ontimeout = () => reject(new TypeError("Network request timed out"));
    xhr.onabort = () => reject(abortError());
    signal.addEventListener("abort", () => xhr.abort());
    xhr.send();
  });

const fetchWithFetch = async (
  url: string,
  headers: Headers,
  signal: AbortSignal,
): Promise<{
  response: UpdateResponse;
  read: () => Promise<string>;
}> => {
  const response = await fetch(url, { headers, signal });
  return { response, read: () => response.text() };
};

/** Read once for parsing and diagnostics, under the same request timeout. */
export const fetchUpdateResponse = async ({
  url,
  resource,
  requestHeaders,
  requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS,
  onResponse,
}: UpdateRequest): Promise<{
  response: UpdateResponse;
  body: string | null;
}> => {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeout);
  try {
    const headers = new Headers(requestHeaders);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    const { response, read } =
      Platform.OS === "android" && typeof XMLHttpRequest === "function"
        ? await requestWithoutTimers(url, headers, controller.signal).then(
            ({ response, body }) => ({ response, read: async () => body }),
          )
        : await fetchWithFetch(url, headers, controller.signal);
    let body: string | null = null;
    try {
      body = await read();
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
    // Whatever the fetch rejects with once its timeout aborts it: an
    // AbortError, or Expo's "fetch failed: FetchRequestCanceledException".
    if (timedOut || (error instanceof Error && error.name === "AbortError")) {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};
