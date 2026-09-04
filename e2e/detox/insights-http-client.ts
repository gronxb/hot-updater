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

  const getOverview = () =>
    requestJson<Awaited<ReturnType<ConsoleInsightsQaClient["getOverview"]>>>(
      "/installations/overview",
    );

  return {
    getActiveOverview: () =>
      requestJson<
        Awaited<ReturnType<ConsoleInsightsQaClient["getActiveOverview"]>>
      >("/installations/active?window=24h"),
    getBundleInsights: (bundleId) =>
      requestJson<
        Awaited<ReturnType<ConsoleInsightsQaClient["getBundleInsights"]>>
      >(
        `/bundles/${encodeURIComponent(bundleId)}/events/insights?window=30d&limit=50&offset=0`,
      ),
    getCapabilities: async () => {
      await getOverview();
      return { insights: true };
    },
    getHistory: (installId) =>
      requestJson<Awaited<ReturnType<ConsoleInsightsQaClient["getHistory"]>>>(
        `/installations/${encodeURIComponent(installId)}/events?limit=50&offset=0`,
      ),
    getOverview,
    getSummary: (bundleId) =>
      requestJson<Awaited<ReturnType<ConsoleInsightsQaClient["getSummary"]>>>(
        `/bundles/${encodeURIComponent(bundleId)}/events/summary`,
      ),
    searchInstallations: (query) =>
      requestJson<
        Awaited<ReturnType<ConsoleInsightsQaClient["searchInstallations"]>>
      >(`/installations?query=${encodeURIComponent(query)}&limit=50&offset=0`),
  };
};
