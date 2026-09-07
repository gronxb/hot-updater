import type {
  InsightsBundleSelection,
  InsightsScope,
  ReportingOverview,
} from "../../packages/server/src/insights/domain.ts";

type InsightsEvent = {
  readonly channel: string;
  readonly fromBundleId: string | null;
  readonly id: string;
  readonly installId: string;
  readonly platform: "ios" | "android";
  readonly receivedAtMs: number;
  readonly toBundleId: string;
  readonly type:
    | "RECOVERED"
    | "RELEASE_ADOPTED"
    | "UNCHANGED"
    | "UPDATE_APPLIED";
};

type Installation = {
  readonly channel: string;
  readonly installId: string;
  readonly lastKnownBundleId: string;
  readonly platform: "ios" | "android";
  readonly userId: string | null;
};

type CursorPage<T> = {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
};

type EventCursorPage = CursorPage<InsightsEvent> & {
  readonly beforeReceivedAtMs: number;
};

export type ObservedInsightsEvent = {
  readonly channel: string;
  readonly fromBundleId: string | null;
  readonly installId: string;
  readonly observedAtMs: number;
  readonly platform: "ios" | "android";
  readonly toBundleId: string;
  readonly type: InsightsEvent["type"];
  readonly userId: string;
};

export const readObservedInsightsEvent = (
  value: unknown,
  observedAtMs: number,
): ObservedInsightsEvent | null => {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  if (
    typeof event.installId !== "string" ||
    typeof event.channel !== "string" ||
    (event.platform !== "ios" && event.platform !== "android") ||
    typeof event.toBundleId !== "string" ||
    typeof event.userId !== "string" ||
    (event.type !== "RECOVERED" &&
      event.type !== "RELEASE_ADOPTED" &&
      event.type !== "UNCHANGED" &&
      event.type !== "UPDATE_APPLIED")
  ) {
    return null;
  }
  if (event.type === "UNCHANGED" && event.fromBundleId !== null) return null;
  if (event.type !== "UNCHANGED" && typeof event.fromBundleId !== "string") {
    return null;
  }
  return {
    channel: event.channel,
    fromBundleId: event.fromBundleId as string | null,
    installId: event.installId,
    observedAtMs,
    platform: event.platform,
    toBundleId: event.toBundleId,
    type: event.type,
    userId: event.userId,
  };
};

type PageInput = {
  readonly beforeReceivedAtMs?: number;
  readonly sinceMs?: number;
  readonly cursor?: string;
  readonly limit?: number;
};

export type ConsoleInsightsQaClient = {
  readonly getReportingOverview: (
    input: InsightsScope & {
      readonly window: "24h";
      readonly bundleId?: string;
    },
  ) => Promise<ReportingOverview>;
  readonly getInstallation: (input: {
    readonly installId: string;
  }) => Promise<Installation | null>;
  readonly listEvents: (
    input?: PageInput & { readonly bundle?: InsightsBundleSelection },
  ) => Promise<EventCursorPage>;
  readonly listInstallationEvents: (
    input: PageInput & { readonly installId: string },
  ) => Promise<EventCursorPage>;
  readonly pageInstallationsByCurrentUserId: (
    input: Pick<PageInput, "cursor" | "limit"> & { readonly userId: string },
  ) => Promise<CursorPage<Installation>>;
};

type ConsoleInsightsQaErrorCode = "event-not-found" | "inconsistent-data";

export class ConsoleInsightsQaError extends Error {
  readonly name = "ConsoleInsightsQaError";
  readonly code: ConsoleInsightsQaErrorCode;

  constructor(code: ConsoleInsightsQaErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const PAGE_LIMIT = 50;

const sameEvent = (
  event: InsightsEvent,
  observed: ObservedInsightsEvent,
): boolean =>
  event.installId === observed.installId &&
  event.platform === observed.platform &&
  event.channel === observed.channel &&
  event.type === observed.type &&
  event.fromBundleId === observed.fromBundleId &&
  event.toBundleId === observed.toBundleId;

const readCursorPagesUntil = async <T>(
  readPage: (cursor?: string) => Promise<CursorPage<T>>,
  matches: (row: T) => boolean,
  shouldStop: (rows: readonly T[]) => boolean = () => false,
): Promise<T | undefined> => {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const page = await readPage(cursor);
    const found = page.data.find(matches);
    if (found !== undefined) return found;
    if (page.nextCursor === null || shouldStop(page.data)) return undefined;
    if (seenCursors.has(page.nextCursor)) {
      throw new ConsoleInsightsQaError(
        "inconsistent-data",
        "Console Insights returned a repeated cursor.",
      );
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
};

export const verifyConsoleInsights = async (
  client: ConsoleInsightsQaClient,
  options: {
    readonly observedEvents?: readonly ObservedInsightsEvent[];
    readonly sinceMs?: number;
  } = {},
) => {
  const observedEvents = (options.observedEvents ?? [])
    .filter(
      (event) =>
        options.sinceMs === undefined || event.observedAtMs >= options.sinceMs,
    )
    .toSorted((left, right) => right.observedAtMs - left.observedAtMs);
  if (observedEvents.length === 0) {
    throw new ConsoleInsightsQaError(
      "event-not-found",
      "The app did not report a current E2E Insights event.",
    );
  }

  let matchedObserved: ObservedInsightsEvent | undefined;
  const event = await readCursorPagesUntil(
    (cursor) => client.listEvents({ cursor, limit: PAGE_LIMIT }),
    (row) => {
      matchedObserved = observedEvents.find(
        (observed) =>
          row.receivedAtMs >= (options.sinceMs ?? 0) &&
          sameEvent(row, observed),
      );
      return matchedObserved !== undefined;
    },
    (rows) =>
      options.sinceMs !== undefined &&
      rows.some((row) => row.receivedAtMs < options.sinceMs!),
  );
  if (!event || !matchedObserved) {
    throw new ConsoleInsightsQaError(
      "event-not-found",
      "No current E2E event was returned by the filter-free Insights history.",
    );
  }

  const observed = matchedObserved;
  const [installation, userInstallation] = await Promise.all([
    client.getInstallation({ installId: observed.installId }),
    readCursorPagesUntil(
      (cursor) =>
        client.pageInstallationsByCurrentUserId({
          cursor,
          limit: PAGE_LIMIT,
          userId: observed.userId,
        }),
      (row) => row.installId === observed.installId,
    ),
  ]);
  const movement =
    event.type !== "UPDATE_APPLIED" && event.type !== "RECOVERED"
      ? undefined
      : await readCursorPagesUntil(
          (cursor) =>
            client.listInstallationEvents({
              cursor,
              installId: observed.installId,
              limit: PAGE_LIMIT,
            }),
          (row) => row.id === event.id,
          (rows) =>
            options.sinceMs !== undefined &&
            rows.some((row) => row.receivedAtMs < options.sinceMs!),
        );

  if (
    installation?.installId !== observed.installId ||
    installation.userId !== observed.userId ||
    userInstallation === undefined ||
    ((event.type === "UPDATE_APPLIED" || event.type === "RECOVERED") &&
      movement === undefined)
  ) {
    throw new ConsoleInsightsQaError(
      "inconsistent-data",
      "Console Insights disagrees about the current event and installation.",
    );
  }

  const overview = await client.getReportingOverview({
    bundleId: installation.lastKnownBundleId,
    channel: installation.channel,
    platform: installation.platform,
    window: "24h",
  });
  if (
    !(overview.reportingInstallations.count >= 1) ||
    overview.bundle?.bundleId !== installation.lastKnownBundleId ||
    !(overview.bundle.reportingInstallations.count >= 1)
  ) {
    throw new ConsoleInsightsQaError(
      "inconsistent-data",
      "Console Insights omitted the current installation from reporting counts.",
    );
  }

  const overviews = new Map([
    [
      JSON.stringify([
        installation.platform,
        installation.channel,
        installation.lastKnownBundleId,
      ]),
      overview,
    ],
  ]);
  const outcomeEvidence = [];
  for (const observedOutcome of observedEvents) {
    if (observedOutcome.type === "UNCHANGED") continue;
    const bundleId =
      observedOutcome.type === "RECOVERED"
        ? observedOutcome.fromBundleId!
        : observedOutcome.toBundleId;
    const outcome =
      observedOutcome.type === "RECOVERED"
        ? "recovered"
        : observedOutcome.type === "RELEASE_ADOPTED"
          ? "adopted"
          : "applied";
    const bundle: InsightsBundleSelection = {
      bundleId,
      channel: observedOutcome.channel,
      outcome,
      platform: observedOutcome.platform,
    };
    const key = JSON.stringify([bundle.platform, bundle.channel, bundleId]);
    let selected = overviews.get(key);
    if (selected === undefined) {
      selected = await client.getReportingOverview({
        bundleId,
        channel: bundle.channel,
        platform: bundle.platform,
        window: "24h",
      });
      overviews.set(key, selected);
    }
    const count = selected.bundle?.[`${outcome}Reports`].count;
    if (selected.bundle?.bundleId !== bundleId || !count || count < 1) {
      throw new ConsoleInsightsQaError(
        "inconsistent-data",
        `Console Insights omitted the ${outcome} report for bundle ${bundleId}.`,
      );
    }
    const report = await readCursorPagesUntil(
      (cursor) =>
        client.listEvents({
          beforeReceivedAtMs: selected.beforeReceivedAtMs,
          bundle,
          cursor,
          limit: PAGE_LIMIT,
          sinceMs: selected.sinceMs,
        }),
      (row) =>
        row.receivedAtMs >= (options.sinceMs ?? 0) &&
        sameEvent(row, observedOutcome),
    );
    if (!report) {
      throw new ConsoleInsightsQaError(
        "inconsistent-data",
        `Console Insights ${outcome} drill-down omitted its observed report.`,
      );
    }
    outcomeEvidence.push({ bundleId, count, eventId: report.id, outcome });
  }

  return {
    reportingInstallations: overview.reportingInstallations.count,
    selectedBundleInstallations: overview.bundle.reportingInstallations.count,
    outcomes: outcomeEvidence,
    eventId: event.id,
    eventType: event.type,
    installId: observed.installId,
    userId: observed.userId,
  };
};
