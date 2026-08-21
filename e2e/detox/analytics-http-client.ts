import type { ConsoleAnalyticsQaClient } from "./console-analytics-qa.ts";

type ConsoleAnalyticsHttpClientOptions = {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: HeadersInit;
};

export class ConsoleAnalyticsHttpError extends Error {
  readonly name = "ConsoleAnalyticsHttpError";
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string) {
    super(`Expected Analytics route ${url} returned HTTP ${status}.`);
    this.status = status;
    this.url = url;
  }
}

const routeUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, "")}${path}`;

export const createConsoleAnalyticsHttpClient = ({
  baseUrl,
  fetch: fetchImplementation = globalThis.fetch,
  headers,
}: ConsoleAnalyticsHttpClientOptions): ConsoleAnalyticsQaClient => {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "application/json");

  const requestJson = async <T>(path: string): Promise<T> => {
    const url = routeUrl(baseUrl, path);
    const response = await fetchImplementation(url, {
      headers: requestHeaders,
    });
    if (!response.ok) {
      throw new ConsoleAnalyticsHttpError(response.status, url);
    }
    return (await response.json()) as T;
  };

  const getOverview = () =>
    requestJson<Awaited<ReturnType<ConsoleAnalyticsQaClient["getOverview"]>>>(
      "/installations/overview",
    );

  return {
    getActiveOverview: () =>
      requestJson<
        Awaited<ReturnType<ConsoleAnalyticsQaClient["getActiveOverview"]>>
      >("/installations/active?window=24h"),
    getBundleAnalytics: (bundleId) =>
      requestJson<
        Awaited<ReturnType<ConsoleAnalyticsQaClient["getBundleAnalytics"]>>
      >(
        `/bundles/${encodeURIComponent(bundleId)}/events/analytics?window=30d&limit=50&offset=0`,
      ),
    getCapabilities: async () => {
      await getOverview();
      return { analytics: true };
    },
    getHistory: (installId) =>
      requestJson<Awaited<ReturnType<ConsoleAnalyticsQaClient["getHistory"]>>>(
        `/installations/${encodeURIComponent(installId)}/events?limit=50&offset=0`,
      ),
    getOverview,
    getSummary: (bundleId) =>
      requestJson<Awaited<ReturnType<ConsoleAnalyticsQaClient["getSummary"]>>>(
        `/bundles/${encodeURIComponent(bundleId)}/events/summary`,
      ),
    searchInstallations: (query) =>
      requestJson<
        Awaited<ReturnType<ConsoleAnalyticsQaClient["searchInstallations"]>>
      >(`/installations?query=${encodeURIComponent(query)}&limit=50&offset=0`),
  };
};
