import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsModel,
  type InsightsPageEventsInput,
  type InsightsPageEventsResult,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsPageContract,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_PAGE_MAX_BYTES,
  isCanonicalInsightsEventId,
  readInsightsPageEventsInput,
} from "@hot-updater/plugin-core/internal";
import type { ClientSession, Filter, MongoClient } from "mongodb";

import { assertMongoInsightsEventRow } from "./mongodbInsights";
import { createMongoInsightsInstallationQueries } from "./mongodbInsightsInstallations";
import {
  createMongoInsightsModelCollections,
  type MongoInsightsProjectionEvent,
  MONGO_INSIGHTS_PROJECTION_STATE_ID,
  MONGO_INSIGHTS_STORAGE_VERSION,
} from "./mongodbInsightsModelSchema";
import {
  assertMongoInsightsProjectionEvent,
  assertMongoInsightsProjectionState,
  mongoInsightsInstallationKey,
  mongoInsightsProjectionSourceGeneration,
} from "./mongodbInsightsProjection";
import {
  getMongoInsightsReport,
  pageMongoInsightsReport,
} from "./mongodbInsightsReports";
import {
  appendMongoInsightsSourceEvent,
  createMongoInsightsSourceCollections,
} from "./mongodbInsightsSource";
import { isMongoInsightsDatabaseNamespace } from "./mongodbInsightsSourceSchema";

const transactionOptions = {
  readPreference: "primary" as const,
  readConcern: { level: "snapshot" as const },
  writeConcern: { w: "majority" as const },
};

const eventIndexes = [
  "insights_projection_received_idx",
  "insights_projection_install_event_idx",
  "insights_projection_to_bundle_event_idx",
  "insights_projection_from_bundle_event_idx",
] as const;

const compareEventRows = (
  left: BundleEventRow,
  right: BundleEventRow,
): number =>
  left.received_at_ms > right.received_at_ms
    ? -1
    : left.received_at_ms < right.received_at_ms
      ? 1
      : left.id < right.id
        ? 1
        : left.id > right.id
          ? -1
          : 0;

const readEventCursor = (
  input: InsightsPageEventsInput,
  databaseNamespace: string,
): { readonly receivedAtMs: number; readonly id: string } | undefined => {
  if (input.cursor === undefined) return undefined;
  try {
    assertInsightsCursorContract(input.cursor);
    const cursor: unknown = JSON.parse(input.cursor);
    const selectorValue =
      input.selector.kind === "installationId"
        ? input.selector.installId
        : input.selector.kind === "bundleId"
          ? input.selector.bundleId
          : null;
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 8 ||
      cursor[0] !== 1 ||
      cursor[1] !== databaseNamespace ||
      cursor[2] !== input.selector.kind ||
      cursor[3] !== selectorValue ||
      cursor[4] !== (input.sinceReceivedAtMs ?? null) ||
      cursor[5] !== input.beforeReceivedAtMs ||
      !Number.isSafeInteger(cursor[6]) ||
      (cursor[6] as number) < (input.sinceReceivedAtMs ?? 0) ||
      (cursor[6] as number) >= input.beforeReceivedAtMs ||
      !isCanonicalInsightsEventId(cursor[7])
    )
      throw null;
    return { receivedAtMs: cursor[6] as number, id: cursor[7] };
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
};

const pageEventsInSnapshot = async (
  client: MongoClient,
  input: InsightsPageEventsInput,
  session: ClientSession,
  databaseNamespace: string,
): Promise<InsightsPageEventsResult> => {
  try {
    input = readInsightsPageEventsInput(input);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  const cursor = readEventCursor(input, databaseNamespace);
  const collections = createMongoInsightsModelCollections(client);
  let state;
  try {
    state = assertMongoInsightsProjectionState(
      await collections.projectionState.findOne(
        { _id: MONGO_INSIGHTS_PROJECTION_STATE_ID },
        { session, promoteLongs: false },
      ),
    );
    if (state.phase !== "ready") throw new InsightsQueryNotReadyError();
  } catch (error) {
    if (!(error instanceof InsightsQueryNotReadyError)) throw error;
    return {
      state: "failed",
      versions: {
        schemaVersion: "1.0.0",
        storageVersion: MONGO_INSIGHTS_STORAGE_VERSION,
        projectionGeneration: null,
        sourceGeneration: "unavailable",
      },
      error: { code: "source-not-ready" },
    };
  }
  if (state.sourceId !== databaseNamespace)
    throw new InsightsQueryNotReadyError();
  const currentSourceGeneration =
    mongoInsightsProjectionSourceGeneration(state);
  const branches: readonly {
    readonly index: number;
    readonly filter: Filter<MongoInsightsProjectionEvent>;
  }[] =
    input.selector.kind === "all"
      ? [{ index: 0, filter: {} }]
      : input.selector.kind === "installationId"
        ? ["UPDATE_APPLIED", "RECOVERED"].map((type) => ({
            index: 1,
            filter: {
              installKey: mongoInsightsInstallationKey(
                input.selector.kind === "installationId"
                  ? input.selector.installId
                  : "",
              ),
              "event.type": type,
            },
          }))
        : [
            {
              index: 2,
              filter: {
                "event.type": "UPDATE_APPLIED",
                "event.to_bundle_id": input.selector.bundleId,
              },
            },
            {
              index: 3,
              filter: {
                "event.type": "RECOVERED",
                "event.from_bundle_id": input.selector.bundleId,
              },
            },
          ];
  const candidateLimit = input.limit + 1;
  const streams = await Promise.all(
    branches.map(async (branch) => {
      const read = (
        range: Filter<MongoInsightsProjectionEvent>,
        limit: number,
      ) =>
        collections.projectionEvents
          .find(
            {
              ...branch.filter,
              ...range,
            },
            { session, singleBatch: true, promoteLongs: false },
          )
          .hint(eventIndexes[branch.index]!)
          .sort({ "event.received_at_ms": -1, _id: -1 })
          .limit(limit)
          .batchSize(limit)
          .toArray();
      const ties = cursor
        ? await read(
            {
              "event.received_at_ms": cursor.receivedAtMs,
              _id: { $lt: cursor.id },
            },
            candidateLimit,
          )
        : [];
      if (ties.length === candidateLimit) return ties;
      const older = await read(
        {
          "event.received_at_ms": {
            $gte: input.sinceReceivedAtMs ?? 0,
            $lt: cursor?.receivedAtMs ?? input.beforeReceivedAtMs,
          },
        },
        candidateLimit - ties.length,
      );
      return [...ties, ...older];
    }),
  );
  const candidates = streams
    .flat()
    .sort((left, right) => compareEventRows(left.event, right.event));
  for (const candidate of candidates) {
    assertMongoInsightsProjectionEvent(candidate);
    if (
      input.selector.kind === "installationId" &&
      candidate.event.install_id !== input.selector.installId
    )
      throw new DatabasePluginInputError("invalid-result");
  }
  if (new Set(candidates.map((row) => row._id)).size !== candidates.length)
    throw new DatabasePluginInputError("invalid-result");
  const versions = {
    schemaVersion: "1.0.0" as const,
    storageVersion: MONGO_INSIGHTS_STORAGE_VERSION,
    projectionGeneration: null,
    sourceGeneration: currentSourceGeneration,
  };
  const cursorFor = (event: BundleEventRow): string =>
    JSON.stringify([
      1,
      databaseNamespace,
      input.selector.kind,
      input.selector.kind === "installationId"
        ? input.selector.installId
        : input.selector.kind === "bundleId"
          ? input.selector.bundleId
          : null,
      input.sinceReceivedAtMs ?? null,
      input.beforeReceivedAtMs,
      event.received_at_ms,
      event.id,
    ]);
  const build = (
    rows: readonly BundleEventRow[],
    nextCursor: string | null,
  ) => ({
    state: "ready" as const,
    versions,
    data: {
      data: rows,
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "live" as const,
        cutoff: {
          kind: "event-time" as const,
          beforeReceivedAtMs: input.beforeReceivedAtMs,
        },
      },
      total: { state: "unavailable" as const },
    },
  });
  const rows: BundleEventRow[] = [];
  for (const [index, candidate] of candidates.slice(0, input.limit).entries()) {
    assertMongoInsightsEventRow(candidate.event);
    const trial = [...rows, candidate.event];
    const nextCursor =
      index + 1 < candidates.length ? cursorFor(candidate.event) : null;
    if (
      getCanonicalInsightsJsonByteLength(build(trial, nextCursor)) >
      INSIGHTS_PAGE_MAX_BYTES
    )
      break;
    rows.push(candidate.event);
  }
  const last = rows.at(-1);
  const nextCursor =
    last && rows.length < candidates.length ? cursorFor(last) : null;
  const result = build(rows, nextCursor);
  assertInsightsPageContract(result, input.limit);
  return result;
};

const pageEvents = (
  client: MongoClient,
  input: InsightsPageEventsInput,
  databaseNamespace: string,
): Promise<InsightsPageEventsResult> =>
  client
    .withSession({ snapshot: true }, (session) =>
      pageEventsInSnapshot(client, input, session, databaseNamespace),
    )
    .catch(async (error: unknown) => {
      if (
        !(error instanceof DatabasePluginInputError) ||
        error.code !== "invalid-result"
      )
        throw error;
      const collections = createMongoInsightsModelCollections(client);
      const state = assertMongoInsightsProjectionState(
        await collections.projectionState.findOne(
          { _id: MONGO_INSIGHTS_PROJECTION_STATE_ID },
          { promoteLongs: false },
        ),
      );
      const marked = await collections.projectionState.updateOne(
        { _id: state._id, phase: "ready" },
        {
          $set: { phase: "failed", poisonEventId: null },
          $inc: { revision: 1 },
        },
      );
      if (marked.matchedCount !== 1) {
        const current = assertMongoInsightsProjectionState(
          await collections.projectionState.findOne(
            { _id: state._id },
            { promoteLongs: false },
          ),
        );
        if (current.phase !== "failed") throw new InsightsQueryNotReadyError();
      }
      return {
        state: "failed",
        versions: {
          schemaVersion: "1.0.0",
          storageVersion: MONGO_INSIGHTS_STORAGE_VERSION,
          projectionGeneration: null,
          sourceGeneration: mongoInsightsProjectionSourceGeneration(state),
        },
        error: { code: "storage-corruption" },
      };
    });

export const createMongoInsightsModel = (
  client: MongoClient,
  databaseNamespace: string,
  session?: ClientSession,
): InsightsModel => {
  if (!isMongoInsightsDatabaseNamespace(databaseNamespace))
    throw new DatabasePluginInputError("invalid-query");
  const installations = createMongoInsightsInstallationQueries(
    client,
    databaseNamespace,
  );
  return {
    append: async (row) => {
      try {
        assertMongoInsightsEventRow(row);
      } catch (error) {
        if (error instanceof DatabasePluginInputError)
          throw new DatabasePluginInputError("invalid-data");
        throw error;
      }
      const append = (activeSession: ClientSession) =>
        appendMongoInsightsSourceEvent(
          createMongoInsightsSourceCollections(client),
          row,
          activeSession,
          databaseNamespace,
        );
      if (session !== undefined) return append(session);
      return client.withSession((activeSession) =>
        activeSession.withTransaction(
          () => append(activeSession),
          transactionOptions,
        ),
      );
    },
    pageEvents: (input) => pageEvents(client, input, databaseNamespace),
    pageInstallations:
      installations.pageInstallations as InsightsModel["pageInstallations"],
    getReport: (input) =>
      getMongoInsightsReport(client, input, databaseNamespace),
    pageReport: (input) =>
      pageMongoInsightsReport(client, input, databaseNamespace),
  };
};
