export class AnalyticsScanLimitExceededError extends Error {
  constructor(readonly limit: number) {
    super(`Analytics event scan exceeded ${limit} rows.`);
    this.name = "AnalyticsScanLimitExceededError";
  }
}

export class AnalyticsBadRequestError extends Error {
  readonly name = "AnalyticsBadRequestError";
}

export class AnalyticsPayloadTooLargeError extends Error {
  readonly name = "AnalyticsPayloadTooLargeError";

  constructor(readonly maximumBytes: number) {
    super(`Event payload exceeds ${maximumBytes} bytes`);
  }
}
