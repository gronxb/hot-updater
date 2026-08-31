type InsightsEvent = {
  readonly fromBundleId: string;
  readonly id: string;
  readonly receivedAtMs: number;
  readonly toBundleId: string;
  readonly type: "RECOVERED" | "UPDATE_APPLIED";
};

type ObservedInsightsEventBase = {
  readonly installId: string;
  readonly observedAtMs: number;
  readonly toBundleId: string;
};

export type ObservedInsightsEvent = ObservedInsightsEventBase &
  (
    | {
        readonly fromBundleId: string;
        readonly type: "RECOVERED" | "UPDATE_APPLIED";
      }
    | { readonly fromBundleId: null; readonly type: "UNCHANGED" }
  );

export const readObservedInsightsEvent = (
  value: unknown,
  observedAtMs: number,
): ObservedInsightsEvent | null => {
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
  const base = {
    installId: event.installId,
    observedAtMs,
    toBundleId: event.toBundleId,
  };
  if (event.type === "UNCHANGED") {
    return event.fromBundleId === null
      ? { ...base, fromBundleId: null, type: event.type }
      : null;
  }
  return typeof event.fromBundleId === "string"
    ? { ...base, fromBundleId: event.fromBundleId, type: event.type }
    : null;
};

type OffsetResult<T> = {
  readonly data: readonly T[];
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
  };
};

export type ConsoleInsightsQaClient = {
  readonly getActiveOverview: () => Promise<{
    readonly activeInstallations: number;
    readonly bundles: readonly {
      readonly bundleId: string;
      readonly installations: number;
    }[];
  }>;
  readonly getBundleInsights: (bundleId: string) => Promise<{
    readonly recentEvents: OffsetResult<InsightsEvent>;
    readonly summary: {
      readonly installed: number;
      readonly recovered: number;
    };
  }>;
  readonly getCapabilities: () => Promise<{ readonly insights: boolean }>;
  readonly getHistory: (
    installId: string,
  ) => Promise<OffsetResult<InsightsEvent>>;
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

type ConsoleInsightsQaErrorCode =
  | "event-not-found"
  | "inconsistent-data"
  | "unsupported";

export class ConsoleInsightsQaError extends Error {
  readonly name = "ConsoleInsightsQaError";
  readonly code: ConsoleInsightsQaErrorCode;

  constructor(code: ConsoleInsightsQaErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const verifyConsoleInsights = async (
  client: ConsoleInsightsQaClient,
  bundleIds: readonly string[],
  options: {
    readonly observedEvents?: readonly ObservedInsightsEvent[];
    readonly sinceMs?: number;
  } = {},
) => {
  const capabilities = await client.getCapabilities();
  if (!capabilities.insights) {
    throw new ConsoleInsightsQaError(
      "unsupported",
      "The configured database does not support Console Insights.",
    );
  }

  let selected:
    | {
        readonly bundleId: string;
        readonly event: InsightsEvent;
        readonly observed: ObservedInsightsEvent;
      }
    | undefined;
  const observedEvents = (options.observedEvents ?? []).filter(
    (event) =>
      options.sinceMs === undefined || event.observedAtMs >= options.sinceMs,
  );
  const observedTransitions = observedEvents.filter(
    (event) => event.type !== "UNCHANGED",
  );
  const insightsBundleIds = new Set(bundleIds);
  for (const event of observedTransitions) {
    insightsBundleIds.add(
      event.type === "RECOVERED" ? event.fromBundleId : event.toBundleId,
    );
  }

  for (const bundleId of insightsBundleIds) {
    const insights = await client.getBundleInsights(bundleId);
    const candidate = insights.recentEvents.data
      .filter(
        (entry) =>
          options.sinceMs === undefined ||
          entry.receivedAtMs >= options.sinceMs,
      )
      .map((event) => ({
        event,
        observed: observedTransitions
          .filter(
            (observed) =>
              observed.type === event.type &&
              observed.fromBundleId === event.fromBundleId &&
              observed.toBundleId === event.toBundleId,
          )
          .sort((left, right) => right.observedAtMs - left.observedAtMs)[0],
      }))
      .filter(
        (
          entry,
        ): entry is {
          readonly event: InsightsEvent;
          readonly observed: ObservedInsightsEvent;
        } => entry.observed !== undefined,
      )
      .sort(
        (left, right) => right.event.receivedAtMs - left.event.receivedAtMs,
      )[0];
    if (
      candidate &&
      (!selected || candidate.event.receivedAtMs > selected.event.receivedAtMs)
    ) {
      selected = { bundleId, ...candidate };
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
    throw new ConsoleInsightsQaError(
      "event-not-found",
      "No current E2E bundle event was returned by Console Insights.",
    );
  }

  const { bundleId, event, observed } = selected;
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
    throw new ConsoleInsightsQaError(
      "inconsistent-data",
      "Console Insights queries disagree about the current E2E event.",
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
