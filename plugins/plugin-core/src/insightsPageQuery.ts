import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import {
  assertInsightsQueryContract,
  INSIGHTS_PAGE_MAX_ROWS,
} from "./insightsContract";
import type {
  InsightsInstallationPageInput,
  InsightsPageEventsInput,
  InsightsPageEventsSelector,
} from "./types/insightsQueries";

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnly = (
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean => Object.keys(value).every((field) => fields.includes(field));

const pageLimit = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= INSIGHTS_PAGE_MAX_ROWS;

const timestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const string = (value: unknown): value is string => typeof value === "string";
const identifier = (value: unknown): value is string =>
  string(value) && value.length > 0;

const validateCommonContract = (input: unknown): void => {
  try {
    assertInsightsQueryContract(input);
  } catch {
    invalid();
  }
};

const optionalCursor = (
  input: Readonly<Record<string, unknown>>,
): { readonly cursor?: string } => {
  if (input.cursor === undefined) return {};
  if (!string(input.cursor)) return invalid();
  return { cursor: input.cursor };
};

/** Strict structural reader for the public bounded event-page request. */
export const readInsightsPageEventsInput = (
  value: unknown,
): InsightsPageEventsInput => {
  validateCommonContract(value);
  if (
    !record(value) ||
    !hasOnly(value, [
      "selector",
      "sinceReceivedAtMs",
      "beforeReceivedAtMs",
      "limit",
      "cursor",
    ]) ||
    !record(value.selector) ||
    !pageLimit(value.limit) ||
    !timestamp(value.beforeReceivedAtMs) ||
    (value.sinceReceivedAtMs !== undefined &&
      !timestamp(value.sinceReceivedAtMs)) ||
    (value.sinceReceivedAtMs ?? 0) > value.beforeReceivedAtMs
  ) {
    return invalid();
  }
  let selector: InsightsPageEventsSelector;
  switch (value.selector.kind) {
    case "all":
      if (!hasOnly(value.selector, ["kind"])) return invalid();
      selector = { kind: "all" };
      break;
    case "installationId":
      if (
        !hasOnly(value.selector, ["kind", "installId"]) ||
        !string(value.selector.installId)
      )
        return invalid();
      selector = {
        kind: "installationId",
        installId: value.selector.installId,
      };
      break;
    case "bundleId":
      if (
        !hasOnly(value.selector, ["kind", "bundleId"]) ||
        !identifier(value.selector.bundleId)
      )
        return invalid();
      selector = { kind: "bundleId", bundleId: value.selector.bundleId };
      break;
    default:
      return invalid();
  }
  return {
    selector,
    ...(value.sinceReceivedAtMs === undefined
      ? {}
      : { sinceReceivedAtMs: value.sinceReceivedAtMs }),
    beforeReceivedAtMs: value.beforeReceivedAtMs,
    limit: value.limit,
    ...optionalCursor(value),
  };
};

/** Strict structural reader for live and publication-backed installation pages. */
export const readInsightsInstallationPageInput = (
  value: unknown,
): InsightsInstallationPageInput => {
  validateCommonContract(value);
  if (!record(value) || !pageLimit(value.limit)) return invalid();
  switch (value.kind) {
    case "all":
      if (!hasOnly(value, ["kind", "limit", "cursor"])) return invalid();
      return { kind: "all", limit: value.limit, ...optionalCursor(value) };
    case "installationId":
      if (
        !hasOnly(value, ["kind", "installId", "limit"]) ||
        !string(value.installId)
      )
        return invalid();
      return {
        kind: "installationId",
        installId: value.installId,
        limit: value.limit,
      };
    case "userId":
    case "contains": {
      const field = value.kind === "userId" ? "userId" : "query";
      if (
        !hasOnly(value, [
          "kind",
          field,
          "publicationId",
          "minAsOfMs",
          "limit",
          "cursor",
        ]) ||
        !identifier(value[field]) ||
        (value.publicationId !== undefined &&
          !identifier(value.publicationId)) ||
        (value.minAsOfMs !== undefined && !timestamp(value.minAsOfMs))
      )
        return invalid();
      const common = {
        ...(value.publicationId === undefined
          ? {}
          : { publicationId: value.publicationId }),
        ...(value.minAsOfMs === undefined
          ? {}
          : { minAsOfMs: value.minAsOfMs }),
        limit: value.limit,
        ...optionalCursor(value),
      };
      return value.kind === "userId"
        ? { kind: value.kind, userId: value.userId as string, ...common }
        : { kind: value.kind, query: value.query as string, ...common };
    }
    default:
      return invalid();
  }
};
