type AnalyticsEvent = {
  readonly fromBundleId: string | null;
  readonly id: string;
  readonly installId: string;
  readonly receivedAtMs: number;
  readonly toBundleId: string;
  readonly type: "RECOVERED" | "UPDATE_APPLIED";
};

type OffsetResult<T> = {
  readonly data: readonly T[];
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
  };
};

export type ConsoleAnalyticsQaClient = {
  readonly getActiveOverview: () => Promise<{
    readonly activeInstallations: number;
  }>;
  readonly getBundleAnalytics: (bundleId: string) => Promise<{
    readonly recentEvents: OffsetResult<AnalyticsEvent>;
    readonly summary: {
      readonly installed: number;
      readonly recovered: number;
    };
  }>;
  readonly getCapabilities: () => Promise<{ readonly analytics: boolean }>;
  readonly getHistory: (
    installId: string,
  ) => Promise<OffsetResult<AnalyticsEvent>>;
  readonly getOverview: () => Promise<{
    readonly trackedInstallations: number;
  }>;
  readonly getSummary: (bundleId: string) => Promise<{
    readonly installed: number;
    readonly recovered: number;
  }>;
  readonly searchInstallations: (
    query: string,
  ) => Promise<OffsetResult<{ readonly installId: string }>>;
};

type ConsoleAnalyticsQaErrorCode =
  | "event-not-found"
  | "inconsistent-data"
  | "unsupported";

export class ConsoleAnalyticsQaError extends Error {
  readonly name = "ConsoleAnalyticsQaError";
  readonly code: ConsoleAnalyticsQaErrorCode;

  constructor(code: ConsoleAnalyticsQaErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const verifyConsoleAnalytics = async (
  client: ConsoleAnalyticsQaClient,
  bundleIds: readonly string[],
  options: { readonly sinceMs?: number } = {},
) => {
  const capabilities = await client.getCapabilities();
  if (!capabilities.analytics) {
    throw new ConsoleAnalyticsQaError(
      "unsupported",
      "The configured database does not support Console Analytics.",
    );
  }

  let selected:
    | { readonly bundleId: string; readonly event: AnalyticsEvent }
    | undefined;
  for (const bundleId of [...new Set(bundleIds)]) {
    const analytics = await client.getBundleAnalytics(bundleId);
    const event = analytics.recentEvents.data
      .filter(
        (entry) =>
          options.sinceMs === undefined ||
          entry.receivedAtMs >= options.sinceMs,
      )
      .sort((left, right) => right.receivedAtMs - left.receivedAtMs)[0];
    if (
      event &&
      (!selected || event.receivedAtMs > selected.event.receivedAtMs)
    ) {
      selected = { bundleId, event };
    }
  }

  if (!selected) {
    throw new ConsoleAnalyticsQaError(
      "event-not-found",
      "No current E2E bundle event was returned by Console Analytics.",
    );
  }

  const { bundleId, event } = selected;
  const [summary, overview, active, installations, history] = await Promise.all(
    [
      client.getSummary(bundleId),
      client.getOverview(),
      client.getActiveOverview(),
      client.searchInstallations(event.installId),
      client.getHistory(event.installId),
    ],
  );
  const installationFound = installations.data.some(
    (entry) => entry.installId === event.installId,
  );
  const eventFound = history.data.some((entry) => entry.id === event.id);
  const summaryCount = summary.installed + summary.recovered;
  if (
    summaryCount < 1 ||
    overview.trackedInstallations < 1 ||
    active.activeInstallations < 1 ||
    !installationFound ||
    !eventFound
  ) {
    throw new ConsoleAnalyticsQaError(
      "inconsistent-data",
      "Console Analytics queries disagree about the current E2E event.",
    );
  }

  return {
    activeInstallations: active.activeInstallations,
    bundleId,
    eventId: event.id,
    installId: event.installId,
    trackedInstallations: overview.trackedInstallations,
  };
};
