import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import type {
  InsightsReportPageInput,
  InsightsReportSection,
} from "./types/insightsQueries";

const MAX_CURSOR_LENGTH = 16_384;
const MAX_ORDINAL = "9223372036854775807";

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
): {
  input: CanonicalReportPageInput;
  semanticKey: string;
  nextOrdinal: string;
} => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !identifier(input.publicationId) ||
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
    canonical.publicationId,
    canonical.section,
    "metric" in canonical ? canonical.metric : null,
    "bundleId" in canonical ? canonical.bundleId : null,
  ]);
  let nextOrdinal = "0";
  if (input.cursor !== undefined) {
    if (
      typeof input.cursor !== "string" ||
      input.cursor.length > MAX_CURSOR_LENGTH
    )
      invalid();
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
): string => {
  const { semanticKey } = readInsightsReportPageQuery(input);
  if (!ordinal(nextOrdinal))
    throw new DatabasePluginInputError("invalid-result");
  // Two maximum-length opaque IDs take at most 14,336 characters after the
  // nested JSON escaping; the section and ordinal framing fit below 16,384.
  return JSON.stringify([1, semanticKey, nextOrdinal]);
};
