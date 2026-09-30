import type { HotUpdaterClientContext } from "../../clientPlugin";

export type InsightsEventType =
  | "UNCHANGED"
  | "UPDATE_DOWNLOADED"
  | "UPDATE_APPLIED"
  | "RECOVERED"
  | "UPDATE_FAILED";

/** A `POST /events` body. */
export interface InsightsEventBody {
  readonly eventId: string;
  readonly type: InsightsEventType;
  readonly installId: string;
  readonly userId?: string;
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly fingerprintHash: string | null;
  readonly sdkVersion: string;
  readonly fromBundleId: string | null;
  readonly fromReleaseId: string | null;
  readonly toBundleId: string;
  readonly toReleaseId: string | null;
  readonly updateStrategy: "fingerprint" | "appVersion" | null;
  readonly metadata?: InsightsEventMetadata;
}

/** Details beside an event's fields, by event type. */
export interface InsightsEventMetadata {
  /** UPDATE_FAILED: where and why the update failed. */
  readonly failure?: {
    readonly stage: "check" | "download" | "install";
    readonly reason: string;
    readonly resource?: string;
    readonly httpStatus?: number;
    readonly transport?: string;
    readonly originCode?: string;
    readonly previousProcessExit?: string;
  };
  /** UPDATE_DOWNLOADED: how the bundle arrived. */
  readonly delivery?: "patch" | "manifest" | "archive";
  /** UPDATE_DOWNLOADED: a patch was tried, but a file or the archive came instead. */
  readonly patchFallback?: true;
  /** RECOVERED: why the previous main process exited, on Android 11+. */
  readonly previousProcessExit?: string;
}

/** How the server answered one event. */
export type InsightsDelivery =
  /** The server stored the event, or already had it under its id. */
  | "delivered"
  /** The server runs without Insights: a 404, since it mounts no `/events`. */
  | "disabled"
  /** A 400 for an `UPDATE_FAILED` event, from a server that does not know it. */
  | "refused"
  /** No attempt got an answer the SDK accepts. */
  | "failed";

export interface InsightsEventGate {
  /**
   * Whether to send the event now. It is asked before every attempt, so an
   * event superseded while it waits out a backoff is dropped.
   */
  admit(event: InsightsEventBody): boolean;
  /** Records how an admitted event ended, once per event. */
  settle(event: InsightsEventBody, delivery: InsightsDelivery): void;
}

/** Attempts per Insights event, the first one included. */
const INSIGHTS_MAX_ATTEMPTS = 3;
/** Wait before the second attempt; it doubles for each later attempt. */
const INSIGHTS_RETRY_BASE_DELAY_MS = 1000;
/** Longest wait between attempts, a server's `Retry-After` included. */
const INSIGHTS_RETRY_MAX_DELAY_MS = 30000;

type InsightsAttemptFailure = {
  readonly error: Error;
  /** A network error, timeout, 429 or 5xx may pass on a later attempt. */
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
};

/**
 * Reads `Retry-After` as delay-seconds, the form a server under load sends;
 * an HTTP-date falls back to the backoff.
 */
const parseRetryAfterMs = (value: string | null): number | null => {
  const seconds = value?.trim();
  return seconds && /^\d+$/.test(seconds) ? Number(seconds) * 1000 : null;
};

const getRetryDelayMs = (
  failedAttempt: number,
  retryAfterMs: number | null,
): number =>
  Math.min(
    retryAfterMs ??
      // Jitter spreads the retries of installations that failed together.
      INSIGHTS_RETRY_BASE_DELAY_MS *
        2 ** (failedAttempt - 1) *
        (0.5 + Math.random()),
    INSIGHTS_RETRY_MAX_DELAY_MS,
  );

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Makes one POST, with the context's timeout, and settles with its outcome. */
const postInsightsEvent = async (
  fetch: HotUpdaterClientContext["fetch"],
  event: InsightsEventBody,
): Promise<Exclude<InsightsDelivery, "failed"> | InsightsAttemptFailure> => {
  try {
    const response = await fetch("events", {
      body: JSON.stringify(event),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    if (response.status === 204) return "delivered";
    if (response.status === 404) return "disabled";
    if (response.status === 400 && event.type === "UPDATE_FAILED") {
      return "refused";
    }
    return {
      error: new Error(
        `Expected HTTP 204 from /events, received ${response.status}`,
      ),
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
    };
  } catch (error: unknown) {
    // fetch rejects only when no response arrived (a timeout or a network
    // error), so a later attempt may still get through.
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      retryable: true,
      retryAfterMs: null,
    };
  }
};

export type InsightsEventSender = (event: InsightsEventBody) => Promise<void>;

/**
 * Sends Insights events one at a time and retries each in the background.
 *
 * The server keeps an installation's latest report by arrival, so a later
 * event waits behind an earlier one's retries; otherwise a retried
 * UPDATE_APPLIED could land after the UPDATE_DOWNLOADED that followed it.
 * Callers wait only for first attempts, so a report never waits out a
 * backoff: once an event backs off, every waiting caller is released, and a
 * failure after that only warns. The gate sees each event before each
 * attempt, after every earlier event settled, so it decides with what the
 * server already answered.
 */
export const createInsightsEventSender = (
  fetch: HotUpdaterClientContext["fetch"],
  gate: InsightsEventGate,
): InsightsEventSender => {
  let queue = Promise.resolve();
  let retrying = false;
  const waiting = new Set<() => void>();

  return (event) =>
    new Promise<void>((resolve, reject) => {
      let released = false;
      const release = () => {
        released = true;
        waiting.delete(release);
        resolve();
      };
      if (retrying) release();
      else waiting.add(release);

      queue = queue.then(async () => {
        try {
          for (let attempt = 1; ; attempt += 1) {
            if (!gate.admit(event)) {
              release();
              break;
            }
            const outcome = await postInsightsEvent(fetch, event);
            if (typeof outcome === "string") {
              gate.settle(event, outcome);
              release();
              break;
            }
            if (!outcome.retryable || attempt === INSIGHTS_MAX_ATTEMPTS) {
              gate.settle(event, "failed");
              waiting.delete(release);
              if (released) {
                console.warn(
                  `[HotUpdater] Insights ${event.type} event was not delivered:`,
                  outcome.error,
                );
              } else {
                reject(outcome.error);
              }
              break;
            }
            retrying = true;
            for (const releaseWaiting of waiting) releaseWaiting();
            await wait(getRetryDelayMs(attempt, outcome.retryAfterMs));
          }
        } catch (error: unknown) {
          // A failed request settles in postInsightsEvent, so only a bug gets
          // here. A rejected queue would leave every later event, and a
          // caller waiting on one, pending forever.
          waiting.delete(release);
          if (!released) reject(error);
        } finally {
          retrying = false;
        }
      });
    });
};
