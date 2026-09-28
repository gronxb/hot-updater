import { DatabaseConflictError } from "../database/errors";

export class InsightsBadRequestError extends Error {
  readonly name = "InsightsBadRequestError";
}

export class InsightsPayloadTooLargeError extends Error {
  readonly name = "InsightsPayloadTooLargeError";

  constructor(readonly maximumBytes: number) {
    super(`Event payload exceeds ${maximumBytes} bytes`);
  }
}

/** Error names the AWS SDKs give a throttled request, as their retry strategy classifies them. */
const THROTTLING_NAMES = new Set([
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "RequestThrottled",
  "RequestThrottledException",
  "SlowDown",
  "ThrottledException",
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
]);

/** gRPC's RESOURCE_EXHAUSTED, the status Firestore throttles a request with. */
const RESOURCE_EXHAUSTED = 8;

interface ErrorFields {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: unknown };
}

/**
 * Whether the database is busy rather than broken, so the same request can
 * succeed later: a transaction ran out of retries, or the backend throttled
 * a request. Writes already retry transient failures, throttled ones
 * included, until the budget runs out. A throttled read throws the backend's
 * own error, so it is recognized by what the backends call it: a name the
 * AWS SDKs retry as throttling, HTTP 429, or gRPC's RESOURCE_EXHAUSTED.
 */
export const isDatabaseBusyError = (error: unknown): boolean => {
  if (error instanceof DatabaseConflictError) return true;
  if (typeof error !== "object" || error === null) return false;
  const { name, code, message, status, statusCode, $metadata } =
    error as ErrorFields;
  return (
    (typeof name === "string" && THROTTLING_NAMES.has(name)) ||
    [status, statusCode, $metadata?.httpStatusCode].includes(429) ||
    // A gRPC error's message starts with its status name; other drivers use
    // numeric codes too, such as MongoDB's 8 for an unknown error.
    (code === RESOURCE_EXHAUSTED &&
      typeof message === "string" &&
      message.includes("RESOURCE_EXHAUSTED"))
  );
};
