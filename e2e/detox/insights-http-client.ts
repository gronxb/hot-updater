import type { ConsoleInsightsQaClient } from "./console-insights-qa.ts";

type ConsoleInsightsHttpClientOptions = {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: HeadersInit;
};

export class ConsoleInsightsHttpError extends Error {
  readonly name = "ConsoleInsightsHttpError";
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`Expected Insights route ${url} returned HTTP ${status}.`);
    this.status = status;
    this.url = url;
  }
}

const routeUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}${path}`;

const withQuery = (
  path: string,
  input: Readonly<Record<string, number | string | undefined>>,
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const value = query.toString();
  return value.length === 0 ? path : `${path}?${value}`;
};

export const createConsoleInsightsHttpClient = ({
  baseUrl,
  fetch: fetchImplementation = globalThis.fetch,
  headers,
}: ConsoleInsightsHttpClientOptions): ConsoleInsightsQaClient => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "application/json");

  const requestJson = async <T>(path: string): Promise<T> => {
    const url = routeUrl(baseUrl, path);
    const response = await fetchImplementation(url, {
      headers: requestHeaders,
    });
    if (!response.ok) {
      throw new ConsoleInsightsHttpError(response.status, url);
    }
    return (await response.json()) as T;
  };

  return {
    getActiveOverview: () =>
      requestJson<
        Awaited<ReturnType<ConsoleInsightsQaClient["getActiveOverview"]>>
      >("/installations/active?window=24h"),
    getInstallation: (installId) =>
      requestJson<
        Awaited<ReturnType<ConsoleInsightsQaClient["getInstallation"]>>
      >(`/installations/${encodeURIComponent(installId)}`),
    pageEvents: (input = {}) =>
      requestJson<Awaited<ReturnType<ConsoleInsightsQaClient["pageEvents"]>>>(
        withQuery("/events", input),
      ),
    pageInstallationEvents: (installId, input = {}) =>
      requestJson<
        Awaited<ReturnType<ConsoleInsightsQaClient["pageInstallationEvents"]>>
      >(
        withQuery(
          `/installations/${encodeURIComponent(installId)}/events`,
          input,
        ),
      ),
    pageInstallationsByCurrentUserId: (userId, input = {}) =>
      requestJson<
        Awaited<
          ReturnType<
            ConsoleInsightsQaClient["pageInstallationsByCurrentUserId"]
          >
        >
      >(withQuery("/installations", { userId, ...input })),
  };
};
