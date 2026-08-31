import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsEventPageInput,
  type InsightsEventPage,
  type InsightsScanInput,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventRow,
  compareInsightsEventRows,
  createInsightsEventPageCursor,
  readInsightsEventPageCursor,
} from "@hot-updater/plugin-core/internal";
import type {
  CollectionReference,
  DocumentData,
  Query,
} from "firebase-admin/firestore";

import { parseFirebaseBundleEventRow } from "./firebaseDatabaseParser";
import { requireFirebaseDocumentKey } from "./firebaseDatabasePersistence";
import {
  firebaseEventScopeKey,
  isFirebaseEventId,
  isFirebaseScopeText,
} from "./firebaseEventIndex";

const readRows = async (
  query: Query<DocumentData>,
  limit: number,
): Promise<readonly BundleEventRow[]> => {
  try {
    const snapshot = await query.limit(limit).get();
    if (snapshot.size > limit)
      throw new DatabasePluginInputError("invalid-result");
    return snapshot.docs.map((document) => {
      const row = requireFirebaseDocumentKey(
        "bundle_events",
        document.id,
        parseFirebaseBundleEventRow(document.data(), document.ref.path),
      );
      assertInsightsEventRow(row);
      // Canonical UUIDs have the same order in Firestore and JavaScript.
      if (!isFirebaseEventId(row.id))
        throw new DatabasePluginInputError("invalid-result");
      return row;
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === 9
    ) {
      // Firestore fails an unindexed query instead of scanning the collection.
      throw new InsightsQueryNotReadyError();
    }
    throw error;
  }
};

export const createFirebaseInsightsQueries = (
  events: CollectionReference<DocumentData>,
  ensureSchema: () => Promise<void>,
  ensureEventIndex: () => Promise<void>,
) => ({
  async pageEvents(input: InsightsEventPageInput): Promise<InsightsEventPage> {
    const cursor = readInsightsEventPageCursor(input);
    const scope = input.scope;
    if (
      (cursor !== undefined && !isFirebaseEventId(cursor.id)) ||
      (scope.kind === "installation" &&
        !isFirebaseScopeText(scope.installId)) ||
      (scope.kind === "bundle" && !isFirebaseScopeText(scope.bundleId))
    )
      throw new DatabasePluginInputError("invalid-query");
    await ensureEventIndex();
    const base = events
      .where("received_at_ms", ">=", input.sinceReceivedAtMs ?? 0)
      .where("received_at_ms", "<", input.beforeReceivedAtMs);
    const scoped =
      scope.kind === "all"
        ? [{ query: base, matches: () => true }]
        : scope.kind === "installation"
          ? ["UPDATE_APPLIED", "RECOVERED"].map((type) => ({
              query: base
                .where(
                  "_insights_install_key",
                  "==",
                  firebaseEventScopeKey(scope.installId),
                )
                .where("type", "==", type),
              matches: (row: BundleEventRow) =>
                row.install_id === scope.installId && row.type === type,
            }))
          : [
              {
                query: base
                  .where("type", "==", "UPDATE_APPLIED")
                  .where(
                    "_insights_to_bundle_key",
                    "==",
                    firebaseEventScopeKey(scope.bundleId),
                  ),
                matches: (row: BundleEventRow) =>
                  row.to_bundle_id === scope.bundleId &&
                  row.type === "UPDATE_APPLIED",
              },
              {
                query: base
                  .where("type", "==", "RECOVERED")
                  .where(
                    "_insights_from_bundle_key",
                    "==",
                    firebaseEventScopeKey(scope.bundleId),
                  ),
                matches: (row: BundleEventRow) =>
                  row.from_bundle_id === scope.bundleId &&
                  row.type === "RECOVERED",
              },
            ];
    const candidates = (
      await Promise.all(
        scoped.map(async ({ query: scopedQuery, matches }) => {
          let query = scopedQuery
            .orderBy("received_at_ms", "desc")
            .orderBy("id", "desc");
          if (cursor) query = query.startAfter(cursor.receivedAtMs, cursor.id);
          const rows = await readRows(query, input.limit + 1);
          if (
            rows.some(
              (row, index) =>
                !matches(row) ||
                row.received_at_ms < (input.sinceReceivedAtMs ?? 0) ||
                row.received_at_ms >= input.beforeReceivedAtMs ||
                (cursor !== undefined &&
                  compareInsightsEventRows(row, {
                    received_at_ms: cursor.receivedAtMs,
                    id: cursor.id,
                  }) <= 0) ||
                (index > 0 &&
                  compareInsightsEventRows(rows[index - 1]!, row) >= 0),
            )
          )
            throw new DatabasePluginInputError("invalid-result");
          return rows;
        }),
      )
    )
      .flat()
      .sort(compareInsightsEventRows);
    if (new Set(candidates.map(({ id }) => id)).size !== candidates.length) {
      throw new DatabasePluginInputError("invalid-result");
    }
    const rows = candidates.slice(0, input.limit);
    const last = rows.at(-1);
    return {
      rows,
      nextCursor:
        candidates.length > input.limit && last
          ? createInsightsEventPageCursor(input, {
              receivedAtMs: last.received_at_ms,
              id: last.id,
            })
          : null,
    };
  },

  async scan(input: InsightsScanInput): Promise<readonly BundleEventRow[]> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 1_000 ||
      !Number.isSafeInteger(input.beforeReceivedAtMs) ||
      input.beforeReceivedAtMs < 0 ||
      (input.after !== undefined &&
        (!Number.isSafeInteger(input.after.receivedAtMs) ||
          input.after.receivedAtMs < 0 ||
          typeof input.after.id !== "string" ||
          !isFirebaseEventId(input.after.id)))
    )
      throw new DatabasePluginInputError("invalid-query");
    if (input.after && input.after.receivedAtMs >= input.beforeReceivedAtMs)
      return [];
    await ensureSchema();
    let query = events
      .where("received_at_ms", "<", input.beforeReceivedAtMs)
      .orderBy("received_at_ms", "asc")
      .orderBy("id", "asc");
    if (input.after)
      query = query.startAfter(input.after.receivedAtMs, input.after.id);
    return readRows(query, input.limit);
  },
});
