import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import { assertInsightsQueryContract } from "./insightsContract";
import type {
  InsightsReportInput,
  InsightsReportQuery,
} from "./types/insightsQueries";

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1_024;

const hasOnly = (value: object, fields: readonly string[]): boolean =>
  Object.keys(value).every((field) => fields.includes(field));

/**
 * Stable semantic identity for durable report reservation. The provider adds its
 * storage revision to this key and may hash it for its native key-size limits.
 * Freshness is deliberately excluded: polling must reuse an existing job.
 */
export const readInsightsReportQuery = (
  input: InsightsReportInput,
): { query: InsightsReportQuery; semanticKey: string; minAsOfMs?: number } => {
  try {
    assertInsightsQueryContract(input);
  } catch {
    invalid();
  }
  if (
    typeof input !== "object" ||
    input === null ||
    !hasOnly(input, ["query", "minAsOfMs"]) ||
    (input.minAsOfMs !== undefined &&
      (!Number.isSafeInteger(input.minAsOfMs) || input.minAsOfMs < 0))
  )
    invalid();
  const query = input.query;
  if (typeof query !== "object" || query === null) invalid();
  let canonical: InsightsReportQuery;
  let parts: readonly unknown[];
  switch (query.kind) {
    case "bundleSummaries": {
      if (
        !hasOnly(query, ["kind", "bundleIds", "window"]) ||
        !["24h", "7d", "30d", "all"].includes(query.window) ||
        !Array.isArray(query.bundleIds) ||
        query.bundleIds.length > 100 ||
        !Array.from(query.bundleIds).every(identifier)
      )
        invalid();
      const bundleIds = [...new Set(query.bundleIds)].sort();
      canonical = { kind: query.kind, bundleIds, window: query.window };
      parts = [query.kind, bundleIds, query.window];
      break;
    }
    case "bundleDetail":
      if (
        !hasOnly(query, ["kind", "bundleId", "window"]) ||
        !identifier(query.bundleId) ||
        !["24h", "7d", "30d", "all"].includes(query.window)
      )
        invalid();
      canonical = {
        kind: query.kind,
        bundleId: query.bundleId,
        window: query.window,
      };
      parts = [query.kind, query.bundleId, query.window];
      break;
    case "installationOverview":
      if (!hasOnly(query, ["kind"])) invalid();
      canonical = { kind: query.kind };
      parts = [query.kind];
      break;
    case "activeOverview":
      if (
        !hasOnly(query, ["kind", "window", "userId"]) ||
        !["24h", "7d", "30d"].includes(query.window) ||
        (query.userId !== undefined && !identifier(query.userId))
      )
        invalid();
      canonical = {
        kind: query.kind,
        window: query.window,
        ...(query.userId === undefined ? {} : { userId: query.userId }),
      };
      parts = [query.kind, query.window, query.userId ?? null];
      break;
    default:
      return invalid();
  }
  return {
    query: canonical,
    semanticKey: JSON.stringify([1, ...parts]),
    ...(input.minAsOfMs === undefined ? {} : { minAsOfMs: input.minAsOfMs }),
  };
};
