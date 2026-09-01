import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import {
  assertInsightsCursorContract,
  assertInsightsQueryContract,
  INSIGHTS_PAGE_MAX_ROWS,
  INSIGHTS_STRING_MAX_CODE_UNITS,
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

type CanonicalReportPageRequest = CanonicalReportPageInput &
  Pick<InsightsReportPageInput, "cursor">;

type ParsedReportPageCursor = {
  readonly rawCursor: string;
  readonly databaseNamespace: string;
  readonly semanticKey: string;
  readonly queryKey: string;
  readonly nextOrdinal: string;
};

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= INSIGHTS_STRING_MAX_CODE_UNITS;

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pageLimit = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= INSIGHTS_PAGE_MAX_ROWS;

const ordinal = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_ORDINAL.length &&
  /^(0|[1-9][0-9]*)$/.exec(value)?.[0] === value &&
  (value.length < MAX_ORDINAL.length || value <= MAX_ORDINAL);

const readCursor = (value: unknown): ParsedReportPageCursor => {
  try {
    assertInsightsCursorContract(value);
  } catch {
    return invalid();
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(value as string);
  } catch {
    return invalid();
  }
  if (
    !Array.isArray(envelope) ||
    envelope.length !== 3 ||
    envelope[0] !== 1 ||
    typeof envelope[1] !== "string" ||
    !ordinal(envelope[2])
  ) {
    return invalid();
  }
  let semantic: unknown;
  try {
    semantic = JSON.parse(envelope[1]);
    assertInsightsQueryContract({ semantic });
  } catch {
    return invalid();
  }
  if (
    !Array.isArray(semantic) ||
    semantic.length !== 7 ||
    !identifier(semantic[0]) ||
    semantic[1] !== "report-page" ||
    semantic[2] !== INSIGHTS_REPORT_PAGE_ORDERING_REVISION ||
    JSON.stringify(semantic) !== envelope[1]
  ) {
    return invalid();
  }
  return {
    rawCursor: value as string,
    databaseNamespace: semantic[0],
    semanticKey: envelope[1],
    queryKey: JSON.stringify(semantic.slice(3)),
    nextOrdinal: envelope[2],
  };
};

const readReportPageInput = (
  value: unknown,
): {
  readonly input: CanonicalReportPageRequest;
  readonly cursor?: ParsedReportPageCursor;
} => {
  try {
    assertInsightsQueryContract(value);
  } catch {
    return invalid();
  }
  if (
    !record(value) ||
    !identifier(value.publicationId) ||
    !pageLimit(value.limit)
  ) {
    return invalid();
  }

  const fields = ["publicationId", "section", "limit", "cursor"];
  const base = { publicationId: value.publicationId, limit: value.limit };
  let canonical: CanonicalReportPageInput;
  switch (value.section) {
    case "movementSeries":
    case "movementCohorts":
      fields.push("metric");
      if (value.metric !== "installed" && value.metric !== "recovered") {
        return invalid();
      }
      canonical = { ...base, section: value.section, metric: value.metric };
      break;
    case "bundleDistribution":
    case "activeSeries":
      canonical = { ...base, section: value.section };
      break;
    case "activeBundleSeries":
      fields.push("bundleId");
      if (value.bundleId !== undefined && !identifier(value.bundleId)) {
        return invalid();
      }
      canonical = {
        ...base,
        section: value.section,
        ...(value.bundleId === undefined ? {} : { bundleId: value.bundleId }),
      };
      break;
    default:
      return invalid();
  }
  if (!Object.keys(value).every((field) => fields.includes(field))) {
    return invalid();
  }

  if (value.cursor === undefined) return { input: canonical };
  const cursor = readCursor(value.cursor);
  const queryKey = JSON.stringify([
    canonical.publicationId,
    canonical.section,
    "metric" in canonical ? canonical.metric : null,
    "bundleId" in canonical ? canonical.bundleId : null,
  ]);
  if (cursor.queryKey !== queryKey) {
    return invalid();
  }
  return { input: { ...canonical, cursor: cursor.rawCursor }, cursor };
};

/**
 * Canonicalizes the public request and validates its cursor envelope without
 * comparing the cursor's namespace to a provider-owned durable namespace.
 */
export const readInsightsReportPageInput = (
  value: unknown,
): InsightsReportPageInput => readReportPageInput(value).input;

/** Validates a materialized-rank bookmark; it is never a raw-query offset. */
export const readInsightsReportPageQuery = (
  input: InsightsReportPageInput,
  databaseNamespace: string,
): {
  input: CanonicalReportPageInput;
  semanticKey: string;
  nextOrdinal: string;
} => {
  const parsed = readReportPageInput(input);
  try {
    assertInsightsQueryContract({ databaseNamespace });
  } catch {
    return invalid();
  }
  if (!identifier(databaseNamespace)) return invalid();

  const { cursor: _cursor, ...canonical } = parsed.input;

  const semanticKey = JSON.stringify([
    databaseNamespace,
    "report-page",
    INSIGHTS_REPORT_PAGE_ORDERING_REVISION,
    canonical.publicationId,
    canonical.section,
    "metric" in canonical ? canonical.metric : null,
    "bundleId" in canonical ? canonical.bundleId : null,
  ]);
  if (
    parsed.cursor !== undefined &&
    (parsed.cursor.databaseNamespace !== databaseNamespace ||
      parsed.cursor.semanticKey !== semanticKey)
  ) {
    return invalid();
  }
  return {
    input: canonical,
    semanticKey,
    nextOrdinal: parsed.cursor?.nextOrdinal ?? "0",
  };
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
