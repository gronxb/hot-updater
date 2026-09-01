import { createHash } from "node:crypto";

import {
  createUUIDv7,
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  databaseFields,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_EVENT_ID_PATTERN,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
} from "@hot-updater/plugin-core/internal";
import type {
  ClientSession,
  CollectionInfo,
  Document,
  MongoClient,
  ReadConcern,
} from "mongodb";

import {
  assertMongoInsightsEventRow,
  isMongoInsightsEventId,
  mongoInsightsEventIndexes,
} from "../adapters/mongodbInsights";
import {
  measureMongoInsightsCollection,
  type MongoInsightsStepUsage,
} from "../adapters/mongodbInsightsModelSchema";
import {
  MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
  MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
  MONGO_INSIGHTS_SOURCE_SHARDS,
  MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
  MONGO_INSIGHTS_SOURCE_STATE_ID,
  type MongoBundleEventDocument,
  type MongoInsightsSourceClock,
  type MongoInsightsSourceEvent,
  type MongoInsightsSourceState,
} from "../adapters/mongodbInsightsSourceSchema";
import { createMongoInsightsPreparation } from "./mongoInsightsPreparation";

const EVENT_COLLECTION = "bundle_events";
const UUID_V7 = INSIGHTS_EVENT_ID_PATTERN.source;
const MAX_SEQUENCE = "9223372036854775807";
const SOURCE_SEQUENCE_INDEX = "insights_source_sequence_idx";
const PUBLIC_PROJECTION = {
  ...Object.fromEntries(
    databaseFields.bundle_events.map((field) => [field, 1]),
  ),
  _id: 1,
};
const transactionOptions = {
  readPreference: "primary" as const,
  readConcern: { level: "snapshot" as const },
  writeConcern: { w: "majority" as const },
};

const assertMongoInsightsSourceState = (
  value: MongoInsightsSourceState | null,
): MongoInsightsSourceState => {
  if (
    value === null ||
    value.version !== 1 ||
    (value.phase !== "auditing" && value.phase !== "ready") ||
    !isMongoInsightsEventId(value.sourceId)
  )
    throw new InsightsQueryNotReadyError();
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.processed) ||
    value.processed < 0
  )
    throw new DatabasePluginInputError("invalid-result");
  return value;
};

const mongoInsightsSourceShard = (eventId: string): number => {
  if (!isMongoInsightsEventId(eventId))
    throw new DatabasePluginInputError("invalid-result");
  return (
    createHash("sha256").update(eventId, "utf8").digest()[0]! %
    MONGO_INSIGHTS_SOURCE_SHARDS
  );
};

const stateValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "_id",
      "version",
      "revision",
      "phase",
      "sourceId",
      "eventCollectionUuid",
      "stateCollectionUuid",
      "clockCollectionUuid",
      "ledgerCollectionUuid",
      "upperId",
      "afterId",
      "processed",
    ],
    properties: {
      _id: { enum: [MONGO_INSIGHTS_SOURCE_STATE_ID] },
      version: { enum: [1] },
      revision: { bsonType: "int", minimum: 0 },
      phase: { enum: ["auditing", "ready"] },
      sourceId: { bsonType: "string", pattern: UUID_V7 },
      eventCollectionUuid: { bsonType: "string" },
      stateCollectionUuid: { bsonType: "string" },
      clockCollectionUuid: { bsonType: "string" },
      ledgerCollectionUuid: { bsonType: "string" },
      upperId: { bsonType: ["string", "null"], pattern: UUID_V7 },
      afterId: { bsonType: ["string", "null"], pattern: UUID_V7 },
      processed: { bsonType: ["int", "long"], minimum: 0 },
    },
  },
};
const clockValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["_id", "sourceId", "value"],
    properties: {
      _id: {
        bsonType: "int",
        minimum: 0,
        maximum: MONGO_INSIGHTS_SOURCE_SHARDS - 1,
      },
      sourceId: { bsonType: "string", pattern: UUID_V7 },
      value: { bsonType: "long", minimum: 0 },
    },
  },
};
const ledgerValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: ["_id", "sourceId", "shard", "sequence", "rawId"],
    properties: {
      _id: { bsonType: "string", pattern: UUID_V7 },
      sourceId: { bsonType: "string", pattern: UUID_V7 },
      shard: {
        bsonType: "int",
        minimum: 0,
        maximum: MONGO_INSIGHTS_SOURCE_SHARDS - 1,
      },
      sequence: { bsonType: "long", minimum: 1 },
      rawId: { bsonType: "string" },
    },
  },
};

export class MongoInsightsSourceConflictError extends Error {
  readonly name = "MongoInsightsSourceConflictError";
  constructor() {
    super("Another MongoDB Insights source step advanced the checkpoint.");
  }
}

const parseSequence = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value))
    throw new DatabasePluginInputError("invalid-query");
  const parsed = BigInt(value);
  if (parsed > BigInt(MAX_SEQUENCE))
    throw new DatabasePluginInputError("invalid-query");
  return parsed;
};

export const decodeMongoInsightsSourceGeneration = (
  value: string,
): {
  sourceId: string;
  counters: readonly bigint[];
  operationTime: readonly [number, number];
} => {
  let decoded: unknown;
  try {
    if (typeof value !== "string" || value.length > 1024) throw new Error();
    decoded = JSON.parse(value);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 4 ||
    decoded[0] !== 1 ||
    !isMongoInsightsEventId(decoded[1]) ||
    !Array.isArray(decoded[2]) ||
    decoded[2].length !== MONGO_INSIGHTS_SOURCE_SHARDS ||
    !Array.isArray(decoded[3]) ||
    decoded[3].length !== 2 ||
    !decoded[3].every(
      (part) =>
        typeof part === "number" &&
        Number.isInteger(part) &&
        part >= 0 &&
        part <= 0xffff_ffff,
    )
  )
    throw new DatabasePluginInputError("invalid-query");
  return {
    sourceId: decoded[1],
    counters: decoded[2].map(parseSequence),
    operationTime: decoded[3] as [number, number],
  };
};

const createCollection = async (
  db: ReturnType<MongoClient["db"]>,
  name: string,
  validator: Document,
) => {
  try {
    await db.createCollection(name, {
      collation: { locale: "simple" },
      validator,
      validationLevel: "strict",
      validationAction: "error",
      writeConcern: { w: "majority" },
    });
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      Reflect.get(error, "code") !== 48
    )
      throw error;
    await db.command({
      collMod: name,
      validator,
      validationLevel: "strict",
      validationAction: "error",
      writeConcern: { w: "majority" },
    });
  }
};

const collectionMetadata = async (
  db: ReturnType<MongoClient["db"]>,
): Promise<Map<string, CollectionInfo>> => {
  const names = [
    EVENT_COLLECTION,
    MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
    MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
    MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
  ];
  const found = await db
    .listCollections({ name: { $in: names } }, { nameOnly: false })
    .toArray();
  return new Map(found.map((collection) => [collection.name, collection]));
};

export const createMongoInsightsSource = (
  client: MongoClient,
  usage?: MongoInsightsStepUsage,
) => {
  const db = client.db(undefined, {
    readPreference: "primary",
    readConcern: { level: "local" } as ReadConcern,
    writeConcern: { w: "majority" },
  });
  const events = measureMongoInsightsCollection(
    db.collection<MongoBundleEventDocument>(EVENT_COLLECTION),
    usage,
  );
  const states = measureMongoInsightsCollection(
    db.collection<MongoInsightsSourceState>(
      MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
    ),
    usage,
  );
  const clocks = measureMongoInsightsCollection(
    db.collection<MongoInsightsSourceClock>(
      MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
    ),
    usage,
  );
  const ledger = measureMongoInsightsCollection(
    db.collection<MongoInsightsSourceEvent>(
      MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
    ),
    usage,
  );
  const eventPreparation = createMongoInsightsPreparation(client);
  const mongo = async () => await import("mongodb");

  const readClockSet = async (
    state: MongoInsightsSourceState,
    session?: ClientSession,
  ): Promise<readonly MongoInsightsSourceClock[]> => {
    const values = await clocks
      .find(
        {},
        {
          ...(session === undefined ? undefined : { session }),
          singleBatch: true,
          promoteLongs: false,
        },
      )
      .sort({ _id: 1 })
      .limit(MONGO_INSIGHTS_SOURCE_SHARDS + 1)
      .toArray();
    const { Long } = await mongo();
    if (
      values.length !== MONGO_INSIGHTS_SOURCE_SHARDS ||
      values.some(
        (clock, shard) =>
          clock._id !== shard ||
          clock.sourceId !== state.sourceId ||
          !Long.isLong(clock.value) ||
          clock.value.lessThan(0),
      )
    )
      throw new InsightsQueryNotReadyError();
    return values;
  };

  const uuid = async (collection: CollectionInfo | undefined) => {
    if (!collection?.info?.uuid) throw new InsightsQueryNotReadyError();
    const { EJSON } = (await mongo()).BSON;
    return EJSON.stringify(collection.info.uuid, { relaxed: false });
  };

  const ensureSchema = async (
    eventSchemaReady = false,
  ): Promise<MongoInsightsSourceState> => {
    if (!eventSchemaReady) {
      if (usage !== undefined) usage.requests += 3;
      await eventPreparation.ensureReady();
    }
    const current = assertMongoInsightsSourceState(
      await states.findOne({ _id: MONGO_INSIGHTS_SOURCE_STATE_ID }),
    );
    if (usage !== undefined) usage.requests += 1;
    const metadata = await collectionMetadata(db);
    const { EJSON } = (await mongo()).BSON;
    for (const [name, validator] of [
      [MONGO_INSIGHTS_SOURCE_STATE_COLLECTION, stateValidator],
      [MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION, clockValidator],
      [MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION, ledgerValidator],
    ] as const) {
      const options = metadata.get(name)?.options;
      if (
        !options ||
        options.validationLevel !== "strict" ||
        options.validationAction !== "error" ||
        (options.collation !== undefined &&
          options.collation.locale !== "simple") ||
        EJSON.stringify(options.validator ?? {}, { relaxed: false }) !==
          EJSON.stringify(validator, { relaxed: false })
      )
        throw new InsightsQueryNotReadyError();
    }
    if (
      current.eventCollectionUuid !==
        (await uuid(metadata.get(EVENT_COLLECTION))) ||
      current.stateCollectionUuid !==
        (await uuid(metadata.get(MONGO_INSIGHTS_SOURCE_STATE_COLLECTION))) ||
      current.clockCollectionUuid !==
        (await uuid(metadata.get(MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION))) ||
      current.ledgerCollectionUuid !==
        (await uuid(metadata.get(MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION)))
    )
      throw new InsightsQueryNotReadyError();
    const sourceIndex = (await ledger.listIndexes().toArray()).find(
      ({ name }) => name === SOURCE_SEQUENCE_INDEX,
    );
    if (
      !sourceIndex ||
      JSON.stringify(Object.entries(sourceIndex.key)) !==
        JSON.stringify(
          Object.entries({ sourceId: 1, shard: 1, sequence: 1 }),
        ) ||
      sourceIndex.unique !== true ||
      sourceIndex.hidden ||
      sourceIndex.sparse ||
      sourceIndex.partialFilterExpression !== undefined ||
      (sourceIndex.collation !== undefined &&
        sourceIndex.collation.locale !== "simple")
    )
      throw new InsightsQueryNotReadyError();
    return current;
  };

  return {
    async prepare(input: { readonly writersDrained: true }) {
      if (input?.writersDrained !== true)
        throw new DatabasePluginInputError("invalid-query");
      const pageProgress = await eventPreparation.prepare(input);
      await createCollection(
        db,
        MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
        stateValidator,
      );
      await createCollection(
        db,
        MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
        clockValidator,
      );
      await createCollection(
        db,
        MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
        ledgerValidator,
      );
      const existingIndex = (await ledger.listIndexes().toArray()).find(
        ({ name }) => name === SOURCE_SEQUENCE_INDEX,
      );
      const compatibleIndex =
        existingIndex &&
        JSON.stringify(Object.entries(existingIndex.key)) ===
          JSON.stringify(
            Object.entries({ sourceId: 1, shard: 1, sequence: 1 }),
          ) &&
        existingIndex.unique === true &&
        !existingIndex.hidden &&
        !existingIndex.sparse &&
        existingIndex.partialFilterExpression === undefined &&
        (existingIndex.collation === undefined ||
          existingIndex.collation.locale === "simple");
      if (!compatibleIndex) {
        if (existingIndex) await ledger.dropIndex(SOURCE_SEQUENCE_INDEX);
        await ledger.createIndex(
          { sourceId: 1, shard: 1, sequence: 1 },
          {
            name: SOURCE_SEQUENCE_INDEX,
            unique: true,
            collation: { locale: "simple" },
          },
        );
      }
      const metadata = await collectionMetadata(db);
      const existing = await states.findOne({
        _id: MONGO_INSIGHTS_SOURCE_STATE_ID,
      });
      if (existing) {
        const current = await ensureSchema(true);
        await readClockSet(current);
        if (pageProgress.state !== "ready") {
          return { ...pageProgress, stage: "event-pages" as const };
        }
        return {
          state: current.phase,
          stage: "source" as const,
          processed: current.processed,
        };
      }
      const upper = await events
        .find(
          {},
          {
            collation: { locale: "simple" },
            projection: { id: 1, _id: 1 },
            singleBatch: true,
          },
        )
        .hint(mongoInsightsEventIndexes[0].name)
        .sort({ id: -1 })
        .limit(1)
        .toArray();
      if (upper[0] && !isMongoInsightsEventId(upper[0].id))
        throw new DatabasePluginInputError("invalid-result");
      const sourceId = createUUIDv7();
      const state: MongoInsightsSourceState = {
        _id: MONGO_INSIGHTS_SOURCE_STATE_ID,
        version: 1,
        revision: 0,
        phase:
          upper.length === 0 && pageProgress.state === "ready"
            ? "ready"
            : "auditing",
        sourceId,
        eventCollectionUuid: await uuid(metadata.get(EVENT_COLLECTION)),
        stateCollectionUuid: await uuid(
          metadata.get(MONGO_INSIGHTS_SOURCE_STATE_COLLECTION),
        ),
        clockCollectionUuid: await uuid(
          metadata.get(MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION),
        ),
        ledgerCollectionUuid: await uuid(
          metadata.get(MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION),
        ),
        upperId: upper[0]?.id ?? null,
        afterId: null,
        processed: 0,
      };
      const { Int32, Long } = await mongo();
      await client.withSession((session) =>
        session.withTransaction(async () => {
          await states.insertOne(state, { session });
          await clocks.insertMany(
            Array.from(
              { length: MONGO_INSIGHTS_SOURCE_SHARDS },
              (_, shard) => ({
                _id: new Int32(shard) as unknown as number,
                sourceId,
                value: Long.ZERO,
              }),
            ),
            { session },
          );
        }, transactionOptions),
      );
      await ensureSchema(true);
      await readClockSet(state);
      return { state: state.phase, stage: "source" as const, processed: 0 };
    },

    async runStep(input: {
      readonly maxItems: number;
      readonly maxRequests: number;
    }) {
      if (
        !Number.isSafeInteger(input.maxItems) ||
        input.maxItems < 2 ||
        input.maxItems > 200 ||
        !Number.isSafeInteger(input.maxRequests) ||
        input.maxRequests < 13 ||
        input.maxRequests > 1000
      )
        throw new DatabasePluginInputError("invalid-query");
      try {
        await eventPreparation.ensureReady();
      } catch (error) {
        if (!(error instanceof InsightsQueryNotReadyError)) throw error;
        const progress = await eventPreparation.runStep({
          maxItems: input.maxItems,
          maxRequests: 5,
        });
        return {
          ...progress,
          stage: "event-pages" as const,
          requests: progress.requests + 1,
        };
      }
      const candidateLimit = Math.min(
        input.maxItems,
        Math.floor((input.maxRequests - 10) / 3),
      );
      await ensureSchema(true);
      return client.withSession((session) =>
        session.withTransaction(async () => {
          const state = assertMongoInsightsSourceState(
            await states.findOne(
              { _id: MONGO_INSIGHTS_SOURCE_STATE_ID },
              { session },
            ),
          );
          if (state.phase === "ready")
            return {
              state: "ready" as const,
              stage: "source" as const,
              processed: state.processed,
              itemsRead: 0,
              requests: 7,
            };
          if (state.upperId === null)
            throw new DatabasePluginInputError("invalid-result");
          const filter =
            state.afterId === null
              ? { id: { $lte: state.upperId } }
              : { id: { $gt: state.afterId, $lte: state.upperId } };
          const rawRows = await events
            .find(filter, {
              collation: { locale: "simple" },
              session,
              singleBatch: true,
              raw: true,
            })
            .hint(mongoInsightsEventIndexes[0].name)
            .sort({ id: 1 })
            .limit(candidateLimit)
            .batchSize(candidateLimit)
            .toArray();
          const { deserialize, EJSON } = (await mongo()).BSON;
          const rows = rawRows.map((raw) =>
            deserialize(raw as unknown as Uint8Array),
          );
          const rawIds = rawRows.map((raw) =>
            EJSON.stringify(
              deserialize(raw as unknown as Uint8Array, {
                promoteValues: false,
              })._id,
              { relaxed: false },
            ),
          );
          if (rows.length === 0)
            throw new DatabasePluginInputError("invalid-result");
          const clockRows = await clocks
            .find(
              { sourceId: state.sourceId },
              { session, singleBatch: true, promoteLongs: false },
            )
            .sort({ _id: 1 })
            .limit(MONGO_INSIGHTS_SOURCE_SHARDS + 1)
            .toArray();
          const { Long } = await mongo();
          if (
            clockRows.length !== MONGO_INSIGHTS_SOURCE_SHARDS ||
            clockRows.some(
              (clock, shard) =>
                clock._id !== shard ||
                clock.sourceId !== state.sourceId ||
                !Long.isLong(clock.value) ||
                clock.value.lessThan(0),
            )
          )
            throw new DatabasePluginInputError("invalid-result");
          let requests = 9;
          for (const [index, row] of rows.entries()) {
            const rawId = rawIds[index];
            if (typeof rawId !== "string")
              throw new DatabasePluginInputError("invalid-result");
            const { _id: _rawId, ...event } = row;
            assertMongoInsightsEventRow(event);
            const shard = mongoInsightsSourceShard(row.id);
            const existing = await ledger.findOne(
              { _id: row.id },
              { session, promoteLongs: false },
            );
            requests += 1;
            if (existing) {
              if (
                existing.sourceId !== state.sourceId ||
                existing.shard !== shard ||
                !Long.isLong(existing.sequence) ||
                existing.sequence.lessThanOrEqual(0) ||
                existing.sequence.greaterThan(clockRows[shard]!.value) ||
                existing.rawId !== rawId
              )
                throw new DatabasePluginInputError("invalid-result");
              continue;
            }
            const clock = await clocks.findOneAndUpdate(
              {
                _id: shard,
                sourceId: state.sourceId,
                value: { $lt: Long.MAX_VALUE },
              },
              { $inc: { value: Long.ONE } },
              { session, returnDocument: "after", promoteLongs: false },
            );
            if (!clock || !Long.isLong(clock.value))
              throw new InsightsQueryNotReadyError();
            await ledger.insertOne(
              {
                _id: row.id,
                sourceId: state.sourceId,
                shard,
                sequence: clock.value,
                rawId,
              },
              { session },
            );
            clockRows[shard] = clock;
            requests += 2;
          }
          const afterId = rows.at(-1)!.id;
          const ready = afterId === state.upperId;
          const saved = await states.updateOne(
            { _id: MONGO_INSIGHTS_SOURCE_STATE_ID, revision: state.revision },
            {
              $set: { afterId, phase: ready ? "ready" : "auditing" },
              $inc: { revision: 1, processed: rows.length },
            },
            { session },
          );
          if (saved.matchedCount !== 1)
            throw new MongoInsightsSourceConflictError();
          requests += 1;
          return {
            state: ready ? ("ready" as const) : ("auditing" as const),
            stage: "source" as const,
            processed: state.processed + rows.length,
            itemsRead: rows.length,
            requests,
          };
        }, transactionOptions),
      );
    },

    async capture(): Promise<string> {
      const ready = await ensureSchema();
      if (ready.phase !== "ready") throw new InsightsQueryNotReadyError();
      return client.withSession({ causalConsistency: true }, async (session) =>
        session.withTransaction(async () => {
          const state = assertMongoInsightsSourceState(
            await states.findOne(
              { _id: MONGO_INSIGHTS_SOURCE_STATE_ID },
              { session },
            ),
          );
          if (state.phase !== "ready" || state.sourceId !== ready.sourceId)
            throw new InsightsQueryNotReadyError();
          const values = await readClockSet(state, session);
          if (!session.operationTime)
            throw new DatabasePluginInputError("invalid-result");
          return JSON.stringify([
            1,
            state.sourceId,
            values.map(({ value }) => value.toString()),
            [
              session.operationTime.getHighBitsUnsigned(),
              session.operationTime.getLowBitsUnsigned(),
            ],
          ]);
        }, transactionOptions),
      );
    },

    async readPage(input: {
      readonly sourceGeneration: string;
      readonly shard: number;
      readonly afterSequence?: string;
      readonly limit: number;
    }): Promise<readonly { sequence: string; event: BundleEventRow }[]> {
      const generation = decodeMongoInsightsSourceGeneration(
        input.sourceGeneration,
      );
      const after = parseSequence(input.afterSequence ?? "0");
      if (
        !Number.isSafeInteger(input.shard) ||
        input.shard < 0 ||
        input.shard >= MONGO_INSIGHTS_SOURCE_SHARDS ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100 ||
        after > generation.counters[input.shard]!
      )
        throw new DatabasePluginInputError("invalid-query");
      const ready = await ensureSchema();
      if (ready.phase !== "ready" || ready.sourceId !== generation.sourceId)
        throw new InsightsQueryNotReadyError();
      const currentClocks = await readClockSet(ready);
      const { Long } = await mongo();
      if (
        currentClocks.some((clock, shard) =>
          clock.value.lessThan(Long.fromBigInt(generation.counters[shard]!)),
        )
      )
        throw new InsightsQueryNotReadyError();
      const { Timestamp } = await mongo();
      const { EJSON, deserialize } = (await mongo()).BSON;
      return client.withSession(
        { causalConsistency: true },
        async (session) => {
          session.advanceOperationTime(
            new Timestamp({
              t: generation.operationTime[0],
              i: generation.operationTime[1],
            }),
          );
          return session.withTransaction(async () => {
            const state = assertMongoInsightsSourceState(
              await states.findOne(
                { _id: MONGO_INSIGHTS_SOURCE_STATE_ID },
                { session },
              ),
            );
            if (
              state.phase !== "ready" ||
              state.sourceId !== generation.sourceId
            )
              throw new InsightsQueryNotReadyError();
            const prefix = generation.counters[input.shard]!;
            if (after === prefix) return [];
            const candidates = await ledger
              .find(
                {
                  sourceId: generation.sourceId,
                  shard: input.shard,
                  sequence: {
                    $gt: Long.fromBigInt(after),
                    $lte: Long.fromBigInt(prefix),
                  },
                },
                { session, singleBatch: true, promoteLongs: false },
              )
              .hint(SOURCE_SEQUENCE_INDEX)
              .sort({ sequence: 1 })
              .limit(input.limit)
              .batchSize(input.limit)
              .toArray();
            const page: { sequence: string; event: BundleEventRow }[] = [];
            let previous = after;
            let consumedAllCandidates = true;
            for (const candidate of candidates) {
              if (
                candidate.sourceId !== generation.sourceId ||
                candidate.shard !== input.shard ||
                !Long.isLong(candidate.sequence) ||
                candidate.sequence.toBigInt() !== previous + 1n ||
                candidate.sequence.toBigInt() > prefix ||
                !isMongoInsightsEventId(candidate._id)
              )
                throw new DatabasePluginInputError("invalid-result");
              let rawId: unknown;
              try {
                rawId = EJSON.parse(candidate.rawId, { relaxed: false });
              } catch {
                throw new DatabasePluginInputError("invalid-result");
              }
              const raw = await events.findOne(
                { _id: rawId as never },
                {
                  session,
                  projection: PUBLIC_PROJECTION,
                  hint: "_id_",
                  raw: true,
                },
              );
              if (!raw) throw new DatabasePluginInputError("invalid-result");
              const exact = deserialize(raw as unknown as Uint8Array, {
                promoteValues: false,
              });
              const decoded = deserialize(raw as unknown as Uint8Array);
              if (
                decoded.id !== candidate._id ||
                EJSON.stringify(exact._id, { relaxed: false }) !==
                  candidate.rawId
              )
                throw new DatabasePluginInputError("invalid-result");
              const { _id: _rawId, ...event } = decoded;
              assertMongoInsightsEventRow(event);
              const item: { sequence: string; event: BundleEventRow } = {
                sequence: candidate.sequence.toString(),
                event: event as BundleEventRow,
              };
              if (
                getCanonicalInsightsJsonByteLength([...page, item]) >
                INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
              ) {
                if (page.length === 0)
                  throw new DatabasePluginInputError("invalid-result");
                consumedAllCandidates = false;
                break;
              }
              previous = candidate.sequence.toBigInt();
              page.push(item);
            }
            if (
              consumedAllCandidates &&
              candidates.length < input.limit &&
              previous !== prefix
            )
              throw new DatabasePluginInputError("invalid-result");
            return page;
          }, transactionOptions);
        },
      );
    },

    async ensureReady(): Promise<void> {
      const state = await ensureSchema();
      if (state.phase !== "ready") throw new InsightsQueryNotReadyError();
      await readClockSet(state);
    },
  };
};
