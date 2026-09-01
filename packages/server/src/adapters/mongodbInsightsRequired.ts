import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsPageEventsInput,
  type InsightsPageEventsResult,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsPageContract,
  assertInsightsQueryContract,
  compareInsightsEventRows,
  createInsightsEventPageCursor,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_PAGE_MAX_BYTES,
  readInsightsEventPageCursor,
  type RequiredInsightsModel,
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

const pageEventsInSnapshot = async (
  client: MongoClient,
  input: InsightsPageEventsInput,
  session: ClientSession,
): Promise<InsightsPageEventsResult> => {
  try {
    assertInsightsQueryContract(input);
    if (input.cursor !== undefined) assertInsightsCursorContract(input.cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  const legacyInput = {
    scope:
      input.selector.kind === "all"
        ? ({ kind: "all" } as const)
        : input.selector.kind === "installationId"
          ? ({
              kind: "installation",
              installId: input.selector.installId,
            } as const)
          : ({ kind: "bundle", bundleId: input.selector.bundleId } as const),
    sinceReceivedAtMs: input.sinceReceivedAtMs,
    beforeReceivedAtMs: input.beforeReceivedAtMs,
    limit: input.limit,
  };
  let cursorSourceId: string | undefined;
  let eventCursor: string | undefined;
  if (input.cursor !== undefined) {
    try {
      const outer: unknown = JSON.parse(input.cursor);
      if (
        !Array.isArray(outer) ||
        outer.length !== 3 ||
        outer[0] !== 1 ||
        typeof outer[1] !== "string" ||
        typeof outer[2] !== "string"
      )
        throw null;
      cursorSourceId = outer[1];
      eventCursor = outer[2];
    } catch {
      throw new DatabasePluginInputError("invalid-query");
    }
  }
  const cursor = readInsightsEventPageCursor({
    ...legacyInput,
    cursor: eventCursor,
  });
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
  if (cursorSourceId !== undefined && cursorSourceId !== state.sourceId)
    throw new DatabasePluginInputError("invalid-query");
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
    .sort((left, right) => compareInsightsEventRows(left.event, right.event));
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
      state.sourceId,
      createInsightsEventPageCursor(legacyInput, {
        receivedAtMs: event.received_at_ms,
        id: event.id,
      }),
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
): Promise<InsightsPageEventsResult> =>
  client
    .withSession({ snapshot: true }, (session) =>
      pageEventsInSnapshot(client, input, session),
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

export const createMongoRequiredInsightsModel = (
  client: MongoClient,
): RequiredInsightsModel => {
  const installations = createMongoInsightsInstallationQueries(client);
  return {
    append: async (row) => {
      try {
        assertMongoInsightsEventRow(row);
      } catch (error) {
        if (error instanceof DatabasePluginInputError)
          throw new DatabasePluginInputError("invalid-data");
        throw error;
      }
      return client.withSession((session) =>
        session.withTransaction(
          () =>
            appendMongoInsightsSourceEvent(
              createMongoInsightsSourceCollections(client),
              row,
              session,
            ),
          transactionOptions,
        ),
      );
    },
    pageEvents: (input) => pageEvents(client, input),
    pageInstallations:
      installations.pageInstallations as RequiredInsightsModel["pageInstallations"],
    getReport: (input) => getMongoInsightsReport(client, input),
    pageReport: (input) => pageMongoInsightsReport(client, input),
  };
};
