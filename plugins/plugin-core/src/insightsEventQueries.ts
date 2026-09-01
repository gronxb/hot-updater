import { createDatabasePluginCrud } from "./databasePluginCrud";
import { DatabasePluginInputError } from "./databasePluginCrudValidation";
import { validateResult } from "./databasePluginCrudValidationRows";
import {
  assertInsightsCursorContract,
  assertInsightsEventContract,
  assertInsightsQueryContract,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_CURSOR_MAX_BYTES,
  INSIGHTS_PAGE_MAX_BYTES,
  INSIGHTS_PAGE_MAX_ROWS,
} from "./insightsContract";
import type {
  BundleEventRow,
  DatabaseWhere,
  InsightsEventPageInput,
  InsightsEventQueries,
  InsightsEventScope,
  InsightsScanCursor,
  TransactionDatabasePluginImplementation,
} from "./types/internal";

const MAX_IDENTIFIER_LENGTH = 1_024;

const isIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_IDENTIFIER_LENGTH;

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function assertInsightsEventRow(
  value: unknown,
): asserts value is BundleEventRow {
  validateResult("bundle_events", value as BundleEventRow, undefined);
  try {
    assertInsightsEventContract(value);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
}

const scopeKey = (scope: InsightsEventScope): string => {
  if (typeof scope !== "object" || scope === null) {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (scope.kind === "all") return JSON.stringify(["all"]);
  if (scope.kind === "installation" && typeof scope.installId === "string") {
    return JSON.stringify([scope.kind, scope.installId]);
  }
  if (scope.kind === "bundle" && isIdentifier(scope.bundleId)) {
    return JSON.stringify([scope.kind, scope.bundleId]);
  }
  throw new DatabasePluginInputError("invalid-query");
};

export const getInsightsEventPageCursorLimit = (
  _scope: InsightsEventScope,
): number => INSIGHTS_CURSOR_MAX_BYTES;

export const compareInsightsEventRows = (
  left: Pick<BundleEventRow, "received_at_ms" | "id">,
  right: Pick<BundleEventRow, "received_at_ms" | "id">,
): number =>
  right.received_at_ms - left.received_at_ms ||
  (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);

const readCursor = (
  input: InsightsEventPageInput,
  scope: string,
): InsightsScanCursor | undefined => {
  if (input.cursor === undefined) return undefined;
  if (typeof input.cursor !== "string") {
    throw new DatabasePluginInputError("invalid-query");
  }
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 6 ||
    value[0] !== 1 ||
    value[1] !== scope ||
    value[2] !== input.beforeReceivedAtMs ||
    value[3] !== (input.sinceReceivedAtMs ?? 0) ||
    !isTimestamp(value[4]) ||
    value[4] < (input.sinceReceivedAtMs ?? 0) ||
    value[4] >= input.beforeReceivedAtMs ||
    !isIdentifier(value[5])
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  return { receivedAtMs: value[4], id: value[5] };
};

export const readInsightsEventPageCursor = (
  input: InsightsEventPageInput,
): InsightsScanCursor | undefined => {
  if (typeof input !== "object" || input === null) {
    throw new DatabasePluginInputError("invalid-query");
  }
  try {
    assertInsightsQueryContract(input);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  const key = scopeKey(input.scope);
  if (
    !isTimestamp(input.beforeReceivedAtMs) ||
    (input.sinceReceivedAtMs !== undefined &&
      !isTimestamp(input.sinceReceivedAtMs)) ||
    (input.sinceReceivedAtMs ?? 0) > input.beforeReceivedAtMs ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > INSIGHTS_PAGE_MAX_ROWS
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  return readCursor(input, key);
};

export const createInsightsEventPageCursor = (
  input: InsightsEventPageInput,
  last: InsightsScanCursor,
): string => {
  const cursor = JSON.stringify([
    1,
    scopeKey(input.scope),
    input.beforeReceivedAtMs,
    input.sinceReceivedAtMs ?? 0,
    last.receivedAtMs,
    last.id,
  ]);
  try {
    assertInsightsCursorContract(cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  return cursor;
};

const scopeFilters = (
  scope: InsightsEventScope,
): readonly (readonly DatabaseWhere<"bundle_events">[])[] => {
  switch (scope.kind) {
    case "all":
      return [[]];
    case "installation":
      return ["UPDATE_APPLIED", "RECOVERED"].map((type) => [
        { field: "install_id", value: scope.installId },
        { field: "type", value: type },
      ]);
    case "bundle":
      return [
        [
          { field: "type", value: "UPDATE_APPLIED" },
          { field: "to_bundle_id", value: scope.bundleId },
        ],
        [
          { field: "type", value: "RECOVERED" },
          { field: "from_bundle_id", value: scope.bundleId },
        ],
      ];
  }
};

/**
 * Opt-in helper for executors that fill LIMIT or prove predicate exhaustion.
 * Each scope needs an index covering equality filters then (received_at_ms,id),
 * with the same lexicographic ID order as JavaScript. The executor must preserve
 * that index order without computed NULL ordering, in-memory sorts, or hidden
 * response caps. SQL/Mongo/Firestore support must be verified independently;
 * generic findMany support alone is insufficient. Does not register itself.
 */
export const createIndexedInsightsEventQueries = (
  implementation: TransactionDatabasePluginImplementation,
  scopes: readonly InsightsEventScope["kind"][],
  beforePage?: (
    input: InsightsEventPageInput,
    cursor: InsightsScanCursor | undefined,
  ) => Promise<void>,
): InsightsEventQueries => {
  const { findMany } = createDatabasePluginCrud(implementation);
  return {
    version: 1,
    scopes: [...scopes],
    async page(input) {
      const cursor = readInsightsEventPageCursor(input);
      if (!scopes.includes(input.scope.kind)) {
        throw new DatabasePluginInputError("invalid-query");
      }
      await beforePage?.(input, cursor);
      const candidateLimit = input.limit + 1;
      const streams = await Promise.all(
        scopeFilters(input.scope).map(async (filters) => {
          const read = async (
            where: readonly DatabaseWhere<"bundle_events">[],
            limit: number,
            matchesRange: (row: BundleEventRow) => boolean,
          ) => {
            const rows = await findMany({
              model: "bundle_events",
              where: [
                ...filters,
                {
                  field: "received_at_ms",
                  operator: "gte",
                  value: input.sinceReceivedAtMs ?? 0,
                },
                ...where,
              ],
              orderBy: [
                { field: "received_at_ms", direction: "desc" },
                { field: "id", direction: "desc" },
              ],
              limit,
              offset: 0,
            });
            if (
              rows.length > limit ||
              rows.some((row, index) => {
                const previous = rows[index - 1];
                return (
                  !isIdentifier(row.id) ||
                  !isTimestamp(row.received_at_ms) ||
                  row.received_at_ms < (input.sinceReceivedAtMs ?? 0) ||
                  row.received_at_ms >= input.beforeReceivedAtMs ||
                  filters.some(
                    (filter) => row[filter.field] !== filter.value,
                  ) ||
                  !matchesRange(row) ||
                  (previous !== undefined &&
                    compareInsightsEventRows(previous, row) >= 0)
                );
              })
            ) {
              throw new DatabasePluginInputError("invalid-result");
            }
            return rows;
          };
          const ties = cursor
            ? await read(
                [
                  { field: "received_at_ms", value: cursor.receivedAtMs },
                  { field: "id", operator: "lt", value: cursor.id },
                ],
                candidateLimit,
                (row) =>
                  row.received_at_ms === cursor.receivedAtMs &&
                  row.id < cursor.id,
              )
            : [];
          if (ties.length === candidateLimit) return ties;
          const older = await read(
            [
              {
                field: "received_at_ms",
                operator: "lt",
                value: cursor?.receivedAtMs ?? input.beforeReceivedAtMs,
              },
            ],
            candidateLimit - ties.length,
            (row) =>
              row.received_at_ms <
              (cursor?.receivedAtMs ?? input.beforeReceivedAtMs),
          );
          return [...ties, ...older];
        }),
      );
      const candidates = streams.flat().sort(compareInsightsEventRows);
      if (new Set(candidates.map((row) => row.id)).size !== candidates.length) {
        throw new DatabasePluginInputError("invalid-result");
      }
      const rows = candidates.slice(0, input.limit);
      const last = rows.at(-1);
      const page = {
        rows,
        nextCursor:
          candidates.length > input.limit && last
            ? createInsightsEventPageCursor(input, {
                receivedAtMs: last.received_at_ms,
                id: last.id,
              })
            : null,
      };
      if (
        rows.length > input.limit ||
        getCanonicalInsightsJsonByteLength(page) > INSIGHTS_PAGE_MAX_BYTES
      ) {
        throw new DatabasePluginInputError("invalid-result");
      }
      return page;
    },
  };
};
