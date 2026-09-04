type InsightsEvent = {
  readonly fromBundleId: string | null;
  readonly id: string;
  readonly installId: string;
  readonly receivedAtMs: number;
  readonly toBundleId: string;
  readonly type:
    | "RECOVERED"
    | "RELEASE_ADOPTED"
    | "UNCHANGED"
    | "UPDATE_APPLIED";
};

type Installation = {
  readonly installId: string;
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
  readonly fromBundleId: string | null;
  readonly installId: string;
  readonly observedAtMs: number;
  readonly toBundleId: string;
  readonly type: "RECOVERED" | "UNCHANGED" | "UPDATE_APPLIED";
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
    typeof event.toBundleId !== "string" ||
    typeof event.userId !== "string" ||
    (event.type !== "RECOVERED" &&
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
    fromBundleId: event.fromBundleId as string | null,
    installId: event.installId,
    observedAtMs,
    toBundleId: event.toBundleId,
    type: event.type,
    userId: event.userId,
  };
};

type PageInput = {
  readonly beforeReceivedAtMs?: number;
  readonly cursor?: string;
  readonly limit?: number;
};

export type ConsoleInsightsQaClient = {
  readonly getActiveOverview: () => Promise<{
    readonly activeInstallations: number;
  }>;
  readonly getInstallation: (installId: string) => Promise<Installation | null>;
  readonly pageEvents: (input?: PageInput) => Promise<EventCursorPage>;
  readonly pageInstallationEvents: (
    installId: string,
    input?: PageInput,
  ) => Promise<EventCursorPage>;
  readonly pageInstallationsByCurrentUserId: (
    userId: string,
    input?: Pick<PageInput, "cursor" | "limit">,
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
    (cursor) => client.pageEvents({ cursor, limit: PAGE_LIMIT }),
    (row) => {
      matchedObserved = observedEvents.find((observed) =>
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
  const [active, installation, userInstallation] = await Promise.all([
    client.getActiveOverview(),
    client.getInstallation(observed.installId),
    readCursorPagesUntil(
      (cursor) =>
        client.pageInstallationsByCurrentUserId(observed.userId, {
          cursor,
          limit: PAGE_LIMIT,
        }),
      (row) => row.installId === observed.installId,
    ),
  ]);
  const movement =
    event.type === "UNCHANGED"
      ? undefined
      : await readCursorPagesUntil(
          (cursor) =>
            client.pageInstallationEvents(observed.installId, {
              cursor,
              limit: PAGE_LIMIT,
            }),
          (row) => row.id === event.id,
          (rows) =>
            options.sinceMs !== undefined &&
            rows.some((row) => row.receivedAtMs < options.sinceMs!),
        );

  if (
    active.activeInstallations < 1 ||
    installation?.installId !== observed.installId ||
    installation.userId !== observed.userId ||
    userInstallation === undefined ||
    (event.type !== "UNCHANGED" && movement === undefined)
  ) {
    throw new ConsoleInsightsQaError(
      "inconsistent-data",
      "Console Insights disagrees about the current event and installation.",
    );
  }

  return {
    activeInstallations: active.activeInstallations,
    eventId: event.id,
    eventType: event.type,
    installId: observed.installId,
    userId: observed.userId,
  };
};
