import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsInstallationIdentityMatch,
  canonicalInsightsJson,
  InsightsContractError,
} from "@hot-updater/plugin-core/internal";
import {
  Long,
  type ClientSession,
  type Document,
  type MongoClient,
} from "mongodb";

import { assertMongoInsightsEventRow } from "./mongodbInsights";
import {
  createMongoInsightsModelCollections,
  MONGO_INSIGHTS_MODEL_COLLECTIONS,
  type MongoInsightsAlias,
  type MongoInsightsModelCollections,
  type MongoInsightsProjectionEvent,
  type MongoInsightsProjectionState,
  MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
  MONGO_INSIGHTS_PROJECTION_STATE_ID,
  MONGO_INSIGHTS_STORAGE_VERSION,
} from "./mongodbInsightsModelSchema";
import {
  isMongoInsightsDatabaseNamespace,
  MONGO_INSIGHTS_SOURCE_SHARDS,
} from "./mongodbInsightsSourceSchema";

export const mongoInsightsDigest = (value: unknown): string =>
  createHash("sha256")
    .update(canonicalInsightsJson(value), "utf8")
    .digest("hex");

export const mongoInsightsInstallationKey = (installId: string): string =>
  mongoInsightsDigest(installId);

export const assertMongoInsightsProjectionEvent = (
  row: MongoInsightsProjectionEvent,
): void => {
  assertMongoInsightsEventRow(row.event);
  if (
    !isMongoInsightsDatabaseNamespace(row.sourceId) ||
    !Number.isSafeInteger(row.sourceShard) ||
    row.sourceShard < 0 ||
    row.sourceShard >= MONGO_INSIGHTS_SOURCE_SHARDS ||
    !Long.isLong(row.sourceSequence) ||
    row.sourceSequence.lessThanOrEqual(0) ||
    !Long.isLong(row.projectionSequence) ||
    row.projectionSequence.lessThanOrEqual(0) ||
    typeof row.latestVersion !== "boolean" ||
    row._id !== row.event.id ||
    row.installId !== row.event.install_id ||
    row.installKey !== mongoInsightsInstallationKey(row.event.install_id)
  )
    throw new DatabasePluginInputError("invalid-result");
};

const invalidStorage = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

const assertIdentity = (
  digestHex: string,
  expectedInstallId: string,
  actualInstallId: string,
): void => {
  try {
    assertInsightsInstallationIdentityMatch(
      { digestHex, installId: expectedInstallId },
      {
        digestHex: mongoInsightsInstallationKey(actualInstallId),
        installId: actualInstallId,
      },
    );
  } catch (error) {
    if (error instanceof InsightsContractError) invalidStorage();
    throw error;
  }
};

export const assertMongoInsightsProjectionState = (
  value: MongoInsightsProjectionState | null,
): MongoInsightsProjectionState => {
  if (value === null) throw new DatabasePluginInputError("invalid-result");
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !["building", "ready", "failed"].includes(value.phase) ||
    !isMongoInsightsDatabaseNamespace(value.sourceId) ||
    typeof value.targetGeneration !== "string" ||
    !Number.isSafeInteger(value.shard) ||
    value.shard < 0 ||
    value.shard > value.sourceCounters.length ||
    value.sourceCounters.length !== MONGO_INSIGHTS_SOURCE_SHARDS ||
    value.sourceCounters.some(
      (counter) => !Long.isLong(counter) || counter.lessThan(0),
    ) ||
    !Long.isLong(value.nextProjectionSequence) ||
    value.nextProjectionSequence.lessThan(0) ||
    value.sourceCounters.reduce(
      (total, counter) => total + counter.toBigInt(),
      0n,
    ) !== value.nextProjectionSequence.toBigInt() ||
    (value.poisonEventId !== null && typeof value.poisonEventId !== "string") ||
    typeof value.collectionUuids !== "object" ||
    value.collectionUuids === null ||
    Object.keys(value.collectionUuids).length !==
      MONGO_INSIGHTS_MODEL_COLLECTIONS.length ||
    MONGO_INSIGHTS_MODEL_COLLECTIONS.some(
      (name) =>
        typeof value.collectionUuids[name] !== "string" ||
        value.collectionUuids[name].length === 0,
    )
  )
    invalidStorage();
  return value;
};

export const mongoInsightsProjectionSourceGeneration = (
  state: MongoInsightsProjectionState,
): string =>
  JSON.stringify([
    MONGO_INSIGHTS_STORAGE_VERSION,
    state.sourceId,
    state.sourceCounters.map((counter) => counter.toString()),
  ]);

export const assertMongoInsightsProjectionSourceGeneration = (
  value: string,
  sourceId: string,
  projectionUpper: Long,
): void => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    invalidStorage();
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 3 ||
    decoded[0] !== MONGO_INSIGHTS_STORAGE_VERSION ||
    decoded[1] !== sourceId ||
    !Array.isArray(decoded[2]) ||
    decoded[2].length !== MONGO_INSIGHTS_SOURCE_SHARDS ||
    !decoded[2].every(
      (counter) =>
        typeof counter === "string" && /^(0|[1-9][0-9]*)$/.test(counter),
    )
  )
    invalidStorage();
  const counters = (decoded as unknown[])[2] as string[];
  if (
    counters.some((counter) => BigInt(counter) > Long.MAX_VALUE.toBigInt()) ||
    counters.reduce((total, counter) => total + BigInt(counter), 0n) !==
      projectionUpper.toBigInt()
  )
    invalidStorage();
};

const saveInstallation = async (
  collections: MongoInsightsModelCollections,
  event: BundleEventRow,
  projectionSequence: Long,
  session: ClientSession,
): Promise<string> => {
  const installKey = mongoInsightsInstallationKey(event.install_id);
  const stored = await collections.installations.findOneAndUpdate(
    { _id: installKey },
    {
      $setOnInsert: {
        installId: event.install_id,
        firstProjectionSequence: projectionSequence,
      },
    },
    { session, upsert: true, returnDocument: "after", promoteLongs: false },
  );
  if (!stored) throw new DatabasePluginInputError("invalid-result");
  if (!Long.isLong(stored.firstProjectionSequence)) invalidStorage();
  assertIdentity(installKey, event.install_id, stored.installId);
  return installKey;
};

const saveAlias = async (
  collections: MongoInsightsModelCollections,
  input: Omit<MongoInsightsAlias, "_id" | "firstProjectionSequence">,
  projectionSequence: Long,
  session: ClientSession,
): Promise<void> => {
  const aliasId = mongoInsightsDigest([
    1,
    input.kind,
    input.value,
    input.installId,
  ]);
  const stored = await collections.aliases.findOneAndUpdate(
    { _id: aliasId },
    { $setOnInsert: { ...input, firstProjectionSequence: projectionSequence } },
    { session, upsert: true, returnDocument: "after", promoteLongs: false },
  );
  if (!stored) throw new DatabasePluginInputError("invalid-result");
  if (
    stored.kind !== input.kind ||
    stored.value !== input.value ||
    stored.normalized !== input.normalized ||
    stored.installKey !== input.installKey ||
    !Long.isLong(stored.firstProjectionSequence)
  )
    invalidStorage();
  assertIdentity(input.installKey, input.installId, stored.installId);
};

export const materializeMongoInsightsProjectionEvent = async (
  collections: MongoInsightsModelCollections,
  input: {
    readonly event: BundleEventRow;
    readonly sourceId: string;
    readonly sourceShard: number;
    readonly sourceSequence: Long;
    readonly projectionSequence: Long;
  },
  session: ClientSession,
): Promise<void> => {
  assertMongoInsightsEventRow(input.event);
  const installKey = await saveInstallation(
    collections,
    input.event,
    input.projectionSequence,
    session,
  );
  const currentLatest = await collections.projectionEvents.findOne(
    { installKey, latestVersion: true },
    {
      session,
      hint: "insights_projection_install_latest_idx",
      sort: { projectionSequence: -1 },
    },
  );
  const latestVersion =
    currentLatest === null ||
    input.event.received_at_ms > currentLatest.event.received_at_ms ||
    (input.event.received_at_ms === currentLatest.event.received_at_ms &&
      input.event.id > currentLatest.event.id);
  const aliases = [
    { kind: "install" as const, value: input.event.install_id },
    ...(input.event.user_id === null
      ? []
      : [{ kind: "user" as const, value: input.event.user_id }]),
    ...(input.event.username === null
      ? []
      : [{ kind: "username" as const, value: input.event.username }]),
  ];
  for (const alias of aliases) {
    await saveAlias(
      collections,
      {
        ...alias,
        normalized: alias.value.toLowerCase(),
        installKey,
        installId: input.event.install_id,
      },
      input.projectionSequence,
      session,
    );
  }
  await collections.projectionEvents.insertOne(
    {
      _id: input.event.id,
      sourceId: input.sourceId,
      sourceShard: input.sourceShard,
      sourceSequence: input.sourceSequence,
      projectionSequence: input.projectionSequence,
      latestVersion,
      installKey,
      installId: input.event.install_id,
      event: input.event,
    },
    { session },
  );
};

/** Called inside the same transaction as raw/source append. */
export const appendMongoInsightsProjectionEvent = async (
  client: MongoClient,
  input: {
    readonly event: BundleEventRow;
    readonly sourceId: string;
    readonly sourceShard: number;
    readonly sourceSequence: Long;
  },
  session: ClientSession,
): Promise<void> => {
  const state = await client
    .db()
    .collection<MongoInsightsProjectionState>(
      MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
    )
    .findOne(
      { _id: MONGO_INSIGHTS_PROJECTION_STATE_ID },
      { session, promoteLongs: false },
    );
  if (state === null) return;
  const collections = createMongoInsightsModelCollections(client);
  const current = assertMongoInsightsProjectionState(state);
  if (current.sourceId !== input.sourceId)
    throw new InsightsQueryNotReadyError();
  if (current.phase !== "ready") {
    const locked = await collections.projectionState.updateOne(
      { _id: current._id, revision: current.revision },
      { $inc: { revision: 1 } },
      { session },
    );
    if (locked.matchedCount !== 1) throw new InsightsQueryNotReadyError();
    return;
  }
  const previous = current.sourceCounters[input.sourceShard];
  if (
    previous === undefined ||
    input.sourceSequence.toBigInt() !== previous.toBigInt() + 1n ||
    current.nextProjectionSequence.equals(Long.MAX_VALUE)
  )
    throw new InsightsQueryNotReadyError();
  const projectionSequence = current.nextProjectionSequence.add(Long.ONE);
  await materializeMongoInsightsProjectionEvent(
    collections,
    { ...input, projectionSequence },
    session,
  );
  const counterField = `sourceCounters.${input.sourceShard}`;
  const saved = await collections.projectionState.updateOne(
    { _id: current._id, revision: current.revision, phase: "ready" },
    {
      $set: {
        [counterField]: input.sourceSequence,
        nextProjectionSequence: projectionSequence,
      } as Document,
      $inc: { revision: 1 },
    },
    { session },
  );
  if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
};
