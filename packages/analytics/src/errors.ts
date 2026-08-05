export class InvalidAnalyticsProviderError extends Error {
  constructor() {
    super("Invalid Analytics provider.");
    this.name = "InvalidAnalyticsProviderError";
  }
}

export class InvalidAnalyticsCapabilityError extends Error {
  constructor() {
    super("Invalid Analytics capability report.");
    this.name = "InvalidAnalyticsCapabilityError";
  }
}

export class AnalyticsUnavailableError extends Error {
  constructor(readonly operation: string) {
    super(`Analytics operation '${operation}' is unavailable.`);
    this.name = "AnalyticsUnavailableError";
  }
}

export class AnalyticsScanLimitExceededError extends Error {
  constructor(readonly limit: number) {
    super(`Analytics event scan exceeded ${limit} rows.`);
    this.name = "AnalyticsScanLimitExceededError";
  }
}
