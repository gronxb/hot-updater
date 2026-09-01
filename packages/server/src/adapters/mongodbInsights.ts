import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsEventPage,
  type InsightsEventPageInput,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventContract,
  assertInsightsEventRow,
  compareInsightsEventRows,
  createInsightsEventPageCursor,
  databaseFields,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_PAGE_MAX_BYTES,
  InsightsContractError,
  isCanonicalInsightsEventId,
  readInsightsEventPageCursor,
} from "@hot-updater/plugin-core/internal";
import type { Collection, Filter } from "mongodb";

export const isMongoInsightsEventId = (value: unknown): value is string =>
  isCanonicalInsightsEventId(value);
export const assertMongoInsightsEventRow = (value: unknown): void => {
  try {
    assertInsightsEventRow(value);
    assertInsightsEventContract(value);
    if (
      [value.install_id, value.to_bundle_id, value.from_bundle_id].some(
        (identity) => identity !== null && /[\uD800-\uDFFF]/u.test(identity),
      )
    )
      throw new DatabasePluginInputError("invalid-result");
  } catch (error) {
    if (error instanceof InsightsContractError)
      throw new DatabasePluginInputError("invalid-result");
    throw error;
  }
};
const SIMPLE_COLLATION = { locale: "simple" } as const;
const ORDER = { received_at_ms: -1, id: -1 } as const;
const PROJECTION = {
  ...Object.fromEntries(
    databaseFields.bundle_events.map((field) => [field, 1]),
  ),
  _id: 0,
};

// Tooling must create these with simple collation, including collections whose
// default collation is locale-aware. This module does not mutate the schema.
export const mongoInsightsEventIndexes = [
  { name: "bundle_events_id_idx", key: { id: 1 }, unique: true },
  {
    name: "bundle_events_received_at_idx",
    key: { received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_install_type_received_at_idx",
    key: { install_id: 1, type: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_to_bundle_idx",
    key: { type: 1, to_bundle_id: 1, received_at_ms: 1, id: 1 },
  },
  {
    name: "bundle_events_from_bundle_idx",
    key: { type: 1, from_bundle_id: 1, received_at_ms: 1, id: 1 },
  },
] as const;

const isMissingIndex = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  return (
    code === 26 ||
    code === 27 ||
    (code === 2 &&
      String(Reflect.get(error, "message")).includes(
        "hint provided does not correspond to an existing index",
      ))
  );
};

/**
 * Internal native reader, not a complete Insights provider implementation.
 * Before wiring it, ensureEventIndex must certify the migrated source and all
 * writers: valid BundleEventRow shapes (including scalar indexed fields),
 * canonical lowercase UUID event IDs, and safe nonnegative integer timestamps.
 * Raw BSON strings use UTF-8 order, unlike arbitrary JS strings.
 * Existing raw events must be audited without deleting or rewriting them.
 */
export const createMongoInsightsQueries = (
  events: Collection<BundleEventRow>,
  ensureEventIndex: () => Promise<void>,
) => ({
  async pageEvents(input: InsightsEventPageInput): Promise<InsightsEventPage> {
    const cursor = readInsightsEventPageCursor(input);
    const scope = input.scope;
    if (
      (cursor !== undefined && !isCanonicalInsightsEventId(cursor.id)) ||
      (scope.kind !== "all" &&
        /[\uD800-\uDFFF]/u.test(
          scope.kind === "installation" ? scope.installId : scope.bundleId,
        ))
    ) {
      throw new DatabasePluginInputError("invalid-query");
    }
    await ensureEventIndex();
    const branches =
      scope.kind === "all"
        ? [{ index: 1, filter: {} }]
        : scope.kind === "installation"
          ? ["UPDATE_APPLIED", "RECOVERED"].map((type) => ({
              index: 2,
              filter: { install_id: scope.installId, type },
            }))
          : [
              {
                index: 3,
                filter: {
                  to_bundle_id: scope.bundleId,
                  type: "UPDATE_APPLIED",
                },
              },
              {
                index: 4,
                filter: { from_bundle_id: scope.bundleId, type: "RECOVERED" },
              },
            ];
    try {
      const required = new Set([0, ...branches.map(({ index }) => index)]);
      // This enumerates only index metadata, never event documents.
      for await (const index of events.listIndexes()) {
        for (const position of required) {
          const expected = mongoInsightsEventIndexes[position]!;
          if (
            index.name === expected.name &&
            JSON.stringify(Object.entries(index.key)) ===
              JSON.stringify(Object.entries(expected.key)) &&
            (position !== 0 || index.unique === true) &&
            index.sparse !== true &&
            index.hidden !== true &&
            index.partialFilterExpression === undefined &&
            (index.collation === undefined ||
              index.collation.locale === "simple")
          ) {
            required.delete(position);
          }
        }
      }
      if (required.size !== 0) throw new InsightsQueryNotReadyError();

      const streams = await Promise.all(
        branches.map(async (branch) => {
          const read = async (
            range: Filter<BundleEventRow>,
            limit: number,
            matches: (row: BundleEventRow) => boolean,
          ) => {
            const rows = await events
              .find({ ...branch.filter, ...range } as Filter<BundleEventRow>, {
                collation: SIMPLE_COLLATION,
                hint: mongoInsightsEventIndexes[branch.index]!.name,
                projection: PROJECTION,
                sort: ORDER,
              })
              .limit(limit)
              .batchSize(limit)
              .toArray();
            if (rows.length > limit)
              throw new DatabasePluginInputError("invalid-result");
            for (const [position, row] of rows.entries()) {
              assertMongoInsightsEventRow(row);
              const previous = rows[position - 1];
              if (
                !isCanonicalInsightsEventId(row.id) ||
                row.received_at_ms < (input.sinceReceivedAtMs ?? 0) ||
                row.received_at_ms >= input.beforeReceivedAtMs ||
                Object.entries(branch.filter).some(
                  ([key, value]) => Reflect.get(row, key) !== value,
                ) ||
                !matches(row) ||
                (previous !== undefined &&
                  compareInsightsEventRows(previous, row) >= 0)
              ) {
                throw new DatabasePluginInputError("invalid-result");
              }
            }
            return rows;
          };
          const limit = input.limit + 1;
          // Disjoint index ranges avoid an OR plan that scans already-emitted
          // ties. At most N+1 documents are fetched across both range reads.
          const ties = cursor
            ? await read(
                { received_at_ms: cursor.receivedAtMs, id: { $lt: cursor.id } },
                limit,
                (row) =>
                  row.received_at_ms === cursor.receivedAtMs &&
                  row.id < cursor.id,
              )
            : [];
          if (ties.length === limit) return ties;
          const upper = cursor?.receivedAtMs ?? input.beforeReceivedAtMs;
          const older = await read(
            {
              received_at_ms: {
                $gte: input.sinceReceivedAtMs ?? 0,
                $lt: upper,
              },
            },
            limit - ties.length,
            (row) => row.received_at_ms < upper,
          );
          return [...ties, ...older];
        }),
      );
      const candidates = streams.flat().sort(compareInsightsEventRows);
      if (new Set(candidates.map(({ id }) => id)).size !== candidates.length)
        throw new DatabasePluginInputError("invalid-result");
      let rows: BundleEventRow[] = [];
      for (const row of candidates.slice(0, input.limit)) {
        const trialRows = [...rows, row];
        const trialPage = {
          rows: trialRows,
          nextCursor:
            trialRows.length < candidates.length
              ? createInsightsEventPageCursor(input, {
                  receivedAtMs: row.received_at_ms,
                  id: row.id,
                })
              : null,
        };
        if (
          getCanonicalInsightsJsonByteLength(trialPage) >
          INSIGHTS_PAGE_MAX_BYTES
        ) {
          if (rows.length === 0)
            throw new DatabasePluginInputError("invalid-result");
          break;
        }
        rows = trialRows;
      }
      const last = rows.at(-1);
      const page = {
        rows,
        nextCursor:
          candidates.length > rows.length && last
            ? createInsightsEventPageCursor(input, {
                receivedAtMs: last.received_at_ms,
                id: last.id,
              })
            : null,
      };
      if (
        rows.length > input.limit ||
        getCanonicalInsightsJsonByteLength(page) > INSIGHTS_PAGE_MAX_BYTES
      )
        throw new DatabasePluginInputError("invalid-result");
      return page;
    } catch (error) {
      if (isMissingIndex(error)) throw new InsightsQueryNotReadyError();
      throw error;
    }
  },
});
