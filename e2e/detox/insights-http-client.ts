import {
  ConsoleInsightsQaError,
  type ConsoleInsightsQaClient,
} from "./console-insights-qa.ts";

type ConsoleInsightsHttpClientOptions = {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: HeadersInit;
};

type ReadyData = Readonly<Record<string, unknown>> & {
  readonly data?: readonly unknown[];
};

const MAX_READY_REQUESTS = 32;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readyData = (value: unknown, operation: string): ReadyData => {
  if (
    isRecord(value) &&
    (value.state === "ready" || value.state === "stale") &&
    isRecord(value.data)
  ) {
    return value.data;
  }
  throw new ConsoleInsightsQaError(
    "inconsistent-data",
    `${operation} is not ready yet.`,
  );
};

const numberValue = (value: unknown, operation: string): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new ConsoleInsightsQaError(
    "inconsistent-data",
    `${operation} returned an invalid count.`,
  );
};

const pageTotal = (page: ReadyData): number => {
  const total = page.total;
  return isRecord(total) && total.state === "exact"
    ? numberValue(total.value, "Insights page")
    : (page.data?.length ?? 0);
};

const eventRow = (value: unknown) => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.from_bundle_id !== "string" ||
    typeof value.to_bundle_id !== "string" ||
    typeof value.received_at_ms !== "number" ||
    (value.type !== "RECOVERED" && value.type !== "UPDATE_APPLIED")
  ) {
    throw new ConsoleInsightsQaError(
      "inconsistent-data",
      "Insights returned an invalid movement event.",
    );
  }
  return {
    fromBundleId: value.from_bundle_id,
    id: value.id,
    receivedAtMs: value.received_at_ms,
    toBundleId: value.to_bundle_id,
    type: value.type,
  };
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

  const requestReadyData = async (
    path: string,
    operation: string,
  ): Promise<ReadyData> => {
    let preparingJobId: string | undefined;
    for (let attempt = 0; attempt < MAX_READY_REQUESTS; attempt += 1) {
      const value = await requestJson<unknown>(path);
      if (!isRecord(value) || value.state !== "preparing") {
        return readyData(value, operation);
      }
      const job = value.job;
      if (!isRecord(job) || typeof job.id !== "string" || job.id.length === 0) {
        throw new ConsoleInsightsQaError(
          "inconsistent-data",
          `${operation} returned an invalid preparation job.`,
        );
      }
      if (preparingJobId !== undefined && job.id !== preparingJobId) {
        throw new ConsoleInsightsQaError(
          "inconsistent-data",
          `${operation} changed preparation jobs while polling.`,
        );
      }
      preparingJobId = job.id;
    }
    throw new ConsoleInsightsQaError(
      "inconsistent-data",
      `${operation} did not become ready within ${MAX_READY_REQUESTS} requests.`,
    );
  };

  const getOverview = async () => {
    const data = await requestReadyData(
      "/installations/overview",
      "Installation overview",
    );
    const summary = data.summary;
    if (!isRecord(summary)) {
      throw new ConsoleInsightsQaError(
        "inconsistent-data",
        "Installation overview returned no summary.",
      );
    }
    return {
      trackedInstallations: numberValue(
        summary.trackedInstallations,
        "Installation overview",
      ),
    };
  };

  return {
    getActiveOverview: async () => {
      const data = await requestReadyData(
        "/installations/active?window=24h",
        "Active installation overview",
      );
      const summary = data.summary;
      if (!isRecord(summary)) {
        throw new ConsoleInsightsQaError(
          "inconsistent-data",
          "Active installation overview returned no summary.",
        );
      }
      return {
        activeInstallations: numberValue(
          summary.activeInstallations,
          "Active installation overview",
        ),
      };
    },
    getBundleInsights: async (bundleId) => {
      const encodedBundleId = encodeURIComponent(bundleId);
      const [events, report] = await Promise.all([
        requestReadyData(
          `/bundles/${encodedBundleId}/events?limit=50`,
          "Bundle event history",
        ),
        requestReadyData(
          `/bundles/${encodedBundleId}/events/insights?window=30d`,
          "Bundle Insights report",
        ),
      ]);
      const summary = report.summary;
      if (!isRecord(summary)) {
        throw new ConsoleInsightsQaError(
          "inconsistent-data",
          "Bundle Insights returned no summary.",
        );
      }
      return {
        recentEvents: {
          data: (events.data ?? []).map(eventRow),
          pagination: {
            limit: 50,
            offset: 0,
            total: pageTotal(events),
          },
        },
        summary: {
          installed: numberValue(summary.installed, "Bundle Insights"),
          recovered: numberValue(summary.recovered, "Bundle Insights"),
        },
      };
    },
    getCapabilities: async () => {
      await requestReadyData(
        "/installations/overview",
        "Installation overview",
      );
      return { insights: true };
    },
    getHistory: async (installId) => {
      const page = await requestReadyData(
        `/events?installId=${encodeURIComponent(installId)}&limit=50`,
        "Installation event history",
      );
      return {
        data: (page.data ?? []).map(eventRow),
        pagination: {
          limit: 50,
          offset: 0,
          total: pageTotal(page),
        },
      };
    },
    getInstallationBundle: async (installId) => {
      const page = await requestReadyData(
        `/installations?kind=installationId&installId=${encodeURIComponent(installId)}&limit=1`,
        "Installation lookup",
      );
      const row = page.data?.[0];
      if (row === undefined) return null;
      if (!isRecord(row) || typeof row.to_bundle_id !== "string") {
        throw new ConsoleInsightsQaError(
          "inconsistent-data",
          "Installation lookup returned an invalid bundle.",
        );
      }
      return row.to_bundle_id;
    },
    getOverview,
    getSummary: async (bundleId) => {
      const data = await requestReadyData(
        `/bundles/${encodeURIComponent(bundleId)}/events/summary`,
        "Bundle summary",
      );
      const summary = Array.isArray(data.summary) ? data.summary[0] : undefined;
      if (!isRecord(summary)) {
        throw new ConsoleInsightsQaError(
          "inconsistent-data",
          "Bundle summary returned no result.",
        );
      }
      return {
        installed: numberValue(summary.installed, "Bundle summary"),
        recovered: numberValue(summary.recovered, "Bundle summary"),
      };
    },
    searchInstallations: async (query) => {
      const page = await requestReadyData(
        `/installations?kind=contains&query=${encodeURIComponent(query)}&limit=50`,
        "Installation search",
      );
      return {
        data: (page.data ?? []).map((row) => {
          if (!isRecord(row) || typeof row.install_id !== "string") {
            throw new ConsoleInsightsQaError(
              "inconsistent-data",
              "Installation search returned an invalid row.",
            );
          }
          return { installId: row.install_id };
        }),
        pagination: {
          limit: 50,
          offset: 0,
          total: pageTotal(page),
        },
      };
    },
  };
};
