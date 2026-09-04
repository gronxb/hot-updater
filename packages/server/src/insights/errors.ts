export class InsightsScanLimitExceededError extends Error {
  constructor(readonly limit: number) {
    super(`Insights event scan exceeded ${limit} rows.`);
    this.name = "InsightsScanLimitExceededError";
  }
}

export class InsightsBadRequestError extends Error {
  readonly name = "InsightsBadRequestError";
}

export class InsightsPayloadTooLargeError extends Error {
  readonly name = "InsightsPayloadTooLargeError";

  constructor(readonly maximumBytes: number) {
    super(`Event payload exceeds ${maximumBytes} bytes`);
  }
}
