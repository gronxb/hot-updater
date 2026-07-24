export class InvalidAnalyticsProviderError extends Error {
  readonly name = "InvalidAnalyticsProviderError";

  constructor() {
    super("Invalid Analytics provider.");
  }
}

export class InvalidAnalyticsCapabilityError extends Error {
  readonly name = "InvalidAnalyticsCapabilityError";

  constructor() {
    super("Invalid Analytics capability report.");
  }
}

export class AnalyticsUnavailableError extends Error {
  readonly name = "AnalyticsUnavailableError";

  constructor(readonly operation: string) {
    super(`Analytics operation '${operation}' is unavailable.`);
  }
}

export class AnalyticsScanLimitExceededError extends Error {
  readonly name = "AnalyticsScanLimitExceededError";

  constructor(readonly limit: number) {
    super(`Analytics event scan exceeded ${limit} rows.`);
  }
}
