export class InsightsQueryNotReadyError extends Error {
  readonly name = "InsightsQueryNotReadyError";
  readonly code = "INSIGHTS_QUERY_NOT_READY";

  constructor() {
    super("Native Insights queries require the database indexes to be ready.");
  }
}
