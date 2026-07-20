type AnalyticsEvent = {
  readonly fromBundleId: string | null;
  readonly id: string;
  readonly receivedAtMs: number;
  readonly toBundleId: string;
  readonly type: "RECOVERED" | "UPDATE_APPLIED";
};

export type ObservedAnalyticsEvent = {
  readonly fromBundleId: string | null;
  readonly installId: string;
  readonly observedAtMs: number;
  readonly toBundleId: string;
  readonly type: "RECOVERED" | "UNCHANGED" | "UPDATE_APPLIED";
};

export const readObservedAnalyticsEvent = (
  value: unknown,
  observedAtMs: number,
): ObservedAnalyticsEvent | null => {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.installId !== "string" ||
    typeof event.toBundleId !== "string" ||
    (event.type !== "RECOVERED" &&
      event.type !== "UNCHANGED" &&
      event.type !== "UPDATE_APPLIED")
  ) {
    return null;
  }
  const fromBundleId = event.fromBundleId;
  if (fromBundleId !== null && typeof fromBundleId !== "string") return null;
  return {
    fromBundleId,
    installId: event.installId,
    observedAtMs,
    toBundleId: event.toBundleId,
    type: event.type,
  };
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
    readonly bundles: readonly {
      readonly bundleId: string;
      readonly installations: number;
    }[];
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
  options: {
    readonly observedEvents?: readonly ObservedAnalyticsEvent[];
    readonly sinceMs?: number;
  } = {},
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
  const observedEvents = (options.observedEvents ?? []).filter(
    (event) =>
      options.sinceMs === undefined || event.observedAtMs >= options.sinceMs,
  );
  const observedTransitions = observedEvents.filter(
    (event) => event.type !== "UNCHANGED",
  );
  const analyticsBundleIds = new Set(bundleIds);
  for (const event of observedTransitions) {
    analyticsBundleIds.add(
      event.type === "RECOVERED" ? event.fromBundleId : event.toBundleId,
    );
  }

  for (const bundleId of analyticsBundleIds) {
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
    const unchanged = observedEvents
      .filter((event) => event.type === "UNCHANGED")
      .sort((left, right) => right.observedAtMs - left.observedAtMs)[0];
    if (unchanged && observedTransitions.length === 0) {
      const active = await client.getActiveOverview();
      const activeBundle = active.bundles.find(
        (bundle) => bundle.bundleId === unchanged.toBundleId,
      );
      if (active.activeInstallations > 0 && activeBundle?.installations) {
        return {
          activeInstallations: active.activeInstallations,
          bundleId: unchanged.toBundleId,
          installId: unchanged.installId,
          mode: "active" as const,
        };
      }
    }
    throw new ConsoleAnalyticsQaError(
      "event-not-found",
      "No current E2E bundle event was returned by Console Analytics.",
    );
  }

  const { bundleId, event } = selected;
  const observed = observedTransitions
    .filter(
      (candidate) =>
        candidate.type === event.type &&
        candidate.fromBundleId === event.fromBundleId &&
        candidate.toBundleId === event.toBundleId,
    )
    .sort((left, right) => right.observedAtMs - left.observedAtMs)[0];
  if (!observed) {
    throw new ConsoleAnalyticsQaError(
      "inconsistent-data",
      "Console Analytics returned an event that was not observed from the current E2E app.",
    );
  }
  const [summary, overview, active, installations, history] = await Promise.all(
    [
      client.getSummary(bundleId),
      client.getOverview(),
      client.getActiveOverview(),
      client.searchInstallations(observed.installId),
      client.getHistory(observed.installId),
    ],
  );
  const installationFound = installations.data.some(
    (entry) => entry.installId === observed.installId,
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
    installId: observed.installId,
    trackedInstallations: overview.trackedInstallations,
  };
};
