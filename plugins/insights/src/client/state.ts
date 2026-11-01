import type { HotUpdaterClientStorage } from "@hot-updater/protocol";

import type { InsightsEventBody, InsightsHttpResponse } from "./sender";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A day's failure keys kept, so a failing app cannot grow its storage. */
const MAX_FAILURE_KEYS = 32;
/** Events kept for the next launch: the storage value holds this many large ones. */
const MAX_HANDED_OFF_EVENTS = 4;

/** The UTC day of a time, as `YYYY-MM-DD`. */
export const utcDay = (time: number): string =>
  new Date(time).toISOString().slice(0, 10);

/** The start of a time's UTC day, in milliseconds. */
export const utcDayStart = (time: number): number =>
  Math.floor(time / DAY_MS) * DAY_MS;

/** What a report says runs: the fields the server compares to skip a same-day launch. */
export interface RunningReport {
  readonly day: string;
  readonly channel: string;
  readonly appVersion: string;
  readonly bundleId: string;
  readonly releaseId: string | null;
  readonly userId: string | null;
}

/** A report the plugin built, with what the gate needs to decide on it. */
export interface QueuedEvent {
  readonly body: InsightsEventBody;
  /** When the report was made, on this device's clock. A report stored by an older SDK has none. */
  readonly madeAtMs?: number;
  readonly day: string;
  /** For UNCHANGED, UPDATE_APPLIED and RECOVERED: what the report says runs. */
  readonly report: RunningReport | null;
  /** For UPDATE_FAILED: the day's key the failure is reported under. */
  readonly failureKey: string | null;
}

const sameReport = (left: RunningReport, right: RunningReport): boolean =>
  left.day === right.day &&
  left.channel === right.channel &&
  left.appVersion === right.appVersion &&
  left.bundleId === right.bundleId &&
  left.releaseId === right.releaseId &&
  left.userId === right.userId;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const readReport = (report: unknown): RunningReport | null =>
  isRecord(report) &&
  typeof report.day === "string" &&
  typeof report.channel === "string" &&
  typeof report.appVersion === "string" &&
  typeof report.bundleId === "string" &&
  isNullableString(report.releaseId) &&
  isNullableString(report.userId)
    ? {
        day: report.day,
        channel: report.channel,
        appVersion: report.appVersion,
        bundleId: report.bundleId,
        releaseId: report.releaseId,
        userId: report.userId,
      }
    : null;

const parseReport = (value: string | null): RunningReport | null => {
  if (value === null) return null;
  try {
    return readReport(JSON.parse(value));
  } catch {
    // An unreadable value counts as none.
    return null;
  }
};

const parseHandedOffEvents = (value: string | null): QueuedEvent[] => {
  if (value === null) return [];
  try {
    const events: unknown = JSON.parse(value);
    if (!Array.isArray(events)) return [];
    return events.flatMap((event: unknown) => {
      if (
        !isRecord(event) ||
        !isRecord(event.body) ||
        typeof event.body.eventId !== "string" ||
        typeof event.day !== "string" ||
        !isNullableString(event.failureKey)
      ) {
        return [];
      }
      const report = readReport(event.report);
      if (event.report !== null && report === null) return [];
      return [
        {
          body: event.body as unknown as InsightsEventBody,
          ...(Number.isSafeInteger(event.madeAtMs)
            ? { madeAtMs: event.madeAtMs as number }
            : {}),
          day: event.day,
          report,
          failureKey: event.failureKey,
        },
      ];
    });
  } catch {
    // An unreadable value counts as none.
    return [];
  }
};

const parseFailures = (
  value: string | null,
): { readonly day: string; readonly keys: readonly string[] } | null => {
  if (value === null) return null;
  try {
    const failures: unknown = JSON.parse(value);
    if (
      isRecord(failures) &&
      typeof failures.day === "string" &&
      Array.isArray(failures.keys) &&
      failures.keys.every((key) => typeof key === "string")
    ) {
      return { day: failures.day, keys: failures.keys as string[] };
    }
  } catch {
    // An unreadable value counts as none.
  }
  return null;
};

/**
 * The Insights plugin's memory across launches, in its plugin storage. Every
 * read tolerates a missing or unreadable value, and a storage failure only
 * costs a report that would otherwise have been skipped.
 */
export const createInsightsState = (storage: HotUpdaterClientStorage) => {
  /** The server said Insights is off during this runtime. */
  let pausedThisRuntime = false;

  const read = (key: string): string | null => {
    try {
      return storage.get(key);
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string | null) => {
    try {
      storage.set(key, value);
    } catch {
      // Losing the state costs a report, never an update.
    }
  };

  return {
    /**
     * Whether reporting pauses: the server answered that Insights is off
     * during this runtime or in the 24 hours before `now`. A pause that
     * starts after `now`, from a clock that went back, has ended.
     */
    isPaused(now: number): boolean {
      if (pausedThisRuntime) return true;
      const pausedAt = Number(read("pausedAt"));
      return (
        Number.isFinite(pausedAt) &&
        pausedAt > 0 &&
        pausedAt <= now &&
        now < pausedAt + DAY_MS
      );
    },
    pause(now: number) {
      pausedThisRuntime = true;
      write("pausedAt", String(now));
    },
    /** The server stored a report, so Insights is on. */
    resume() {
      if (read("pausedAt") !== null) write("pausedAt", null);
    },

    /** Whether a launch report repeats what the installation reported that day. */
    repeatsReport(report: RunningReport): boolean {
      const last = parseReport(read("report"));
      return last !== null && sameReport(last, report);
    },
    /** Records a delivered report that says what runs. */
    recordReport(report: RunningReport) {
      write("report", JSON.stringify(report));
    },
    /**
     * Forgets the last report after a delivered download or failure, so the
     * next launch reports again, as the server records it after one.
     */
    forgetReport() {
      if (read("report") !== null) write("report", null);
    },

    /** Whether a failure was already reported that day. */
    hasFailure(day: string, key: string): boolean {
      const failures = parseFailures(read("failures"));
      return failures?.day === day && failures.keys.includes(key);
    },
    recordFailure(day: string, key: string) {
      const failures = parseFailures(read("failures"));
      const keys = failures?.day === day ? failures.keys : [];
      if (keys.includes(key)) return;
      write(
        "failures",
        JSON.stringify({ day, keys: [...keys, key].slice(-MAX_FAILURE_KEYS) }),
      );
    },

    readHttpResponse(
      channel: string,
      appVersion: string,
    ): InsightsHttpResponse | undefined {
      try {
        const saved: unknown = JSON.parse(read("httpResponse") ?? "null");
        if (
          !isRecord(saved) ||
          saved.channel !== channel ||
          saved.appVersion !== appVersion ||
          !isRecord(saved.response)
        )
          return undefined;
        const response = saved.response;
        if (
          (response.resource !== "catalog" &&
            response.resource !== "artifact") ||
          typeof response.path !== "string" ||
          response.path.length > 1_024 ||
          typeof response.status !== "number" ||
          !Number.isInteger(response.status) ||
          response.status < 100 ||
          response.status > 599 ||
          !isNullableString(response.body) ||
          JSON.stringify(response.body).length > 4_096 ||
          typeof response.bodyTruncated !== "boolean" ||
          typeof response.receivedAtMs !== "number" ||
          !Number.isSafeInteger(response.receivedAtMs) ||
          response.receivedAtMs < 0
        )
          return undefined;
        return response as unknown as InsightsHttpResponse;
      } catch {
        return undefined;
      }
    },
    recordHttpResponse(
      channel: string,
      appVersion: string,
      response: InsightsHttpResponse,
    ) {
      write("httpResponse", JSON.stringify({ channel, appVersion, response }));
    },

    /** The events held back for a later launch, oldest first. */
    readHandedOffEvents(): QueuedEvent[] {
      return parseHandedOffEvents(read("handedOffEvents"));
    },
    /** Keeps an event for the next launch, once; the oldest makes room. */
    handOffEvent({ body, madeAtMs, day, report, failureKey }: QueuedEvent) {
      const events = parseHandedOffEvents(read("handedOffEvents"));
      if (events.some((event) => event.body.eventId === body.eventId)) return;
      write(
        "handedOffEvents",
        JSON.stringify(
          [...events, { body, madeAtMs, day, report, failureKey }].slice(
            -MAX_HANDED_OFF_EVENTS,
          ),
        ),
      );
    },
    /** An event ended, so no later launch sends it. */
    forgetHandedOffEvent(eventId: string) {
      const events = parseHandedOffEvents(read("handedOffEvents"));
      const others = events.filter((event) => event.body.eventId !== eventId);
      if (others.length === events.length) return;
      write(
        "handedOffEvents",
        others.length === 0 ? null : JSON.stringify(others),
      );
    },

    readUserId(): string | null {
      try {
        const user: unknown = JSON.parse(read("user") ?? "null");
        return isRecord(user) && typeof user.userId === "string"
          ? user.userId
          : null;
      } catch {
        return null;
      }
    },
    writeUserId(userId: string | null) {
      write("user", userId === null ? null : JSON.stringify({ userId }));
    },
  };
};

export type InsightsState = ReturnType<typeof createInsightsState>;
