import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import {
  assertInsightsCursorContract,
  assertInsightsQueryContract,
} from "./insightsContract";
import type {
  InsightsReportPageInput,
  InsightsReportSection,
} from "./types/insightsQueries";

const MAX_ORDINAL = "9223372036854775807";

/** Changes whenever the committed row ordering for report pages changes. */
export const INSIGHTS_REPORT_PAGE_ORDERING_REVISION = 1;

type CanonicalReportPageInput = InsightsReportSection &
  Pick<InsightsReportPageInput, "publicationId" | "limit">;

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1_024;

const ordinal = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_ORDINAL.length &&
  /^(0|[1-9][0-9]*)$/.exec(value)?.[0] === value &&
  (value.length < MAX_ORDINAL.length || value <= MAX_ORDINAL);

/** Validates a materialized-rank bookmark; it is never a raw-query offset. */
export const readInsightsReportPageQuery = (
  input: InsightsReportPageInput,
  databaseNamespace: string,
): {
  input: CanonicalReportPageInput;
  semanticKey: string;
  nextOrdinal: string;
} => {
  try {
    assertInsightsQueryContract(input);
    assertInsightsQueryContract({ databaseNamespace });
  } catch {
    invalid();
  }
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !identifier(input.publicationId) ||
    !identifier(databaseNamespace) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  )
    invalid();

  const fields = ["publicationId", "section", "limit", "cursor"];
  const base = { publicationId: input.publicationId, limit: input.limit };
  let canonical: CanonicalReportPageInput;
  switch (input.section) {
    case "movementSeries":
    case "movementCohorts":
      fields.push("metric");
      if (input.metric !== "installed" && input.metric !== "recovered")
        invalid();
      canonical = { ...base, section: input.section, metric: input.metric };
      break;
    case "bundleDistribution":
    case "activeSeries":
      canonical = { ...base, section: input.section };
      break;
    case "activeBundleSeries":
      fields.push("bundleId");
      if (input.bundleId !== undefined && !identifier(input.bundleId))
        invalid();
      canonical = {
        ...base,
        section: input.section,
        ...(input.bundleId === undefined ? {} : { bundleId: input.bundleId }),
      };
      break;
    default:
      return invalid();
  }
  if (!Object.keys(input).every((field) => fields.includes(field))) invalid();

  const semanticKey = JSON.stringify([
    databaseNamespace,
    "report-page",
    INSIGHTS_REPORT_PAGE_ORDERING_REVISION,
    canonical.publicationId,
    canonical.section,
    "metric" in canonical ? canonical.metric : null,
    "bundleId" in canonical ? canonical.bundleId : null,
  ]);
  let nextOrdinal = "0";
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string") invalid();
    let value: unknown;
    try {
      value = JSON.parse(input.cursor);
    } catch {
      return invalid();
    }
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value[0] !== 1 ||
      value[1] !== semanticKey ||
      !ordinal(value[2])
    )
      return invalid();
    nextOrdinal = value[2];
  }
  return { input: canonical, semanticKey, nextOrdinal };
};

export const createInsightsReportPageCursor = (
  input: InsightsReportPageInput,
  nextOrdinal: string,
  databaseNamespace: string,
): string => {
  const { semanticKey } = readInsightsReportPageQuery(input, databaseNamespace);
  if (!ordinal(nextOrdinal))
    throw new DatabasePluginInputError("invalid-result");
  const cursor = JSON.stringify([1, semanticKey, nextOrdinal]);
  try {
    assertInsightsCursorContract(cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  return cursor;
};
