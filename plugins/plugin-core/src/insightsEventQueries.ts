import { createDatabasePluginCrud } from "./databasePluginCrud";
import { DatabasePluginInputError } from "./databasePluginCrudValidation";
import type {
  BundleEventRow,
  DatabaseWhere,
  InsightsEventPageInput,
  InsightsEventQueries,
  InsightsEventScope,
  InsightsScanCursor,
  TransactionDatabasePluginImplementation,
} from "./types/internal";

const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 8_192;
const MAX_IDENTIFIER_LENGTH = 1_024;

const isIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_IDENTIFIER_LENGTH;

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const scopeKey = (scope: InsightsEventScope): string => {
  if (typeof scope !== "object" || scope === null) {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (scope.kind === "all") return JSON.stringify(["all"]);
  if (scope.kind === "installation" && isIdentifier(scope.installId)) {
    return JSON.stringify([scope.kind, scope.installId]);
  }
  if (scope.kind === "bundle" && isIdentifier(scope.bundleId)) {
    return JSON.stringify([scope.kind, scope.bundleId]);
  }
  throw new DatabasePluginInputError("invalid-query");
};

const compareRows = (
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
  if (
    typeof input.cursor !== "string" ||
    input.cursor.length > MAX_CURSOR_LENGTH
  ) {
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
    value.length !== 5 ||
    value[0] !== 1 ||
    value[1] !== scope ||
    value[2] !== input.beforeReceivedAtMs ||
    !isTimestamp(value[3]) ||
    value[3] >= input.beforeReceivedAtMs ||
    !isIdentifier(value[4])
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  return { receivedAtMs: value[3], id: value[4] };
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
  beforePage?: (input: InsightsEventPageInput) => Promise<void>,
): InsightsEventQueries => {
  const { findMany } = createDatabasePluginCrud(implementation);
  return {
    version: 1,
    scopes: [...scopes],
    async page(input) {
      const key = scopeKey(input.scope);
      if (
        !scopes.includes(input.scope.kind) ||
        !isTimestamp(input.beforeReceivedAtMs) ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_PAGE_SIZE
      ) {
        throw new DatabasePluginInputError("invalid-query");
      }
      const cursor = readCursor(input, key);
      await beforePage?.(input);
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
              where: [...filters, ...where],
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
                  row.received_at_ms >= input.beforeReceivedAtMs ||
                  filters.some(
                    (filter) => row[filter.field] !== filter.value,
                  ) ||
                  !matchesRange(row) ||
                  (previous !== undefined && compareRows(previous, row) >= 0)
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
      const candidates = streams.flat().sort(compareRows);
      if (new Set(candidates.map((row) => row.id)).size !== candidates.length) {
        throw new DatabasePluginInputError("invalid-result");
      }
      const rows = candidates.slice(0, input.limit);
      const last = rows.at(-1);
      return {
        rows,
        nextCursor:
          candidates.length > input.limit && last
            ? JSON.stringify([
                1,
                key,
                input.beforeReceivedAtMs,
                last.received_at_ms,
                last.id,
              ])
            : null,
      };
    },
  };
};
