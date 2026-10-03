/**
 * What Insights' API throws for an input it refuses, such as an unknown
 * event field or a malformed cursor; its routes answer 400 for it.
 */
export class InsightsBadRequestError extends Error {
  readonly name = "InsightsBadRequestError";
}

export class InsightsPayloadTooLargeError extends Error {
  readonly name = "InsightsPayloadTooLargeError";

  constructor(readonly maximumBytes: number) {
    super(`Event payload exceeds ${maximumBytes} bytes`);
  }
}
