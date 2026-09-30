import type { HotUpdaterClientStorage } from "@hot-updater/core";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A day's failure keys kept, so a failing app cannot grow its storage. */
const MAX_FAILURE_KEYS = 32;

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

const parseReport = (value: string | null): RunningReport | null => {
  if (value === null) return null;
  try {
    const report: unknown = JSON.parse(value);
    if (
      isRecord(report) &&
      typeof report.day === "string" &&
      typeof report.channel === "string" &&
      typeof report.appVersion === "string" &&
      typeof report.bundleId === "string" &&
      isNullableString(report.releaseId) &&
      isNullableString(report.userId)
    ) {
      return {
        day: report.day,
        channel: report.channel,
        appVersion: report.appVersion,
        bundleId: report.bundleId,
        releaseId: report.releaseId,
        userId: report.userId,
      };
    }
  } catch {
    // An unreadable value counts as none.
  }
  return null;
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

    /** Whether a failure was already reported, or refused, that day. */
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
