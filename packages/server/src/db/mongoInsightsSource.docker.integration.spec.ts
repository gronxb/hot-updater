import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { BSON, Long, MongoClient, ObjectId, type Document } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createBundleEventRowFixture,
  createBundlePatchRowFixture,
  createBundleRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { findOpenPort } from "../../../test-utils/src/runtimeProcess";
import { mongoAdapter } from "../adapters/mongodb";
import { mongoInsightsSourceShard } from "../adapters/mongodbInsightsSource";
import {
  MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
  MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
  MONGO_INSIGHTS_SOURCE_PAGE_MAX_BYTES,
  MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
} from "../adapters/mongodbInsightsSourceSchema";
import { createMongoInsightsSource } from "./mongoInsightsSource";

const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};
const objectId = (value: number) =>
  new ObjectId(value.toString(16).padStart(24, "0"));
const nearLimitEvent = (suffix: string, receivedAtMs: number) => {
  const base = {
    ...createBundleEventRowFixture(suffix, receivedAtMs),
    username: "",
  };
  const emptyRawBytes = BSON.calculateObjectSize({
    ...base,
    _id: new ObjectId(),
  });
  return {
    ...base,
    username: "x".repeat(16 * 1024 * 1024 - emptyRawBytes),
  };
};
const findStages = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(findStages);
  if (typeof value !== "object" || value === null) return [];
  return [
    ...(typeof Reflect.get(value, "stage") === "string"
      ? [String(Reflect.get(value, "stage"))]
      : []),
    ...Object.values(value).flatMap(findStages),
  ];
};

describe("MongoDB committed Insights source", () => {
  const replicaSet = "insightsSourceRs";
  const container = `hot-updater-mongo-source-${randomUUID().slice(0, 8)}`;
  let client: MongoClient;
  let commands: { name: string; command: Document }[] = [];
  let recording = false;
  let recordCommandDetails = true;
  let getMoreCount = 0;
  const source = () => createMongoInsightsSource(client);
  const database = () => mongoAdapter({ client, transactions: true as const });

  beforeAll(async () => {
    docker(["image", "inspect", "mongo:7-jammy"]);
    const port = await findOpenPort();
    docker([
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--name",
      container,
      "--tmpfs",
      "/data/db:rw,size=768m",
      "--tmpfs",
      "/data/configdb:rw,size=16m",
      "-p",
      `127.0.0.1:${port}:27017`,
      "mongo:7-jammy",
      "--bind_ip_all",
      "--replSet",
      replicaSet,
      "--wiredTigerCacheSizeGB",
      "0.5",
      "--quiet",
    ]);
    const directUri = `mongodb://127.0.0.1:${port}/insights_source?directConnection=true`;
    const bootstrap = new MongoClient(directUri, {
      serverSelectionTimeoutMS: 30_000,
    });
    try {
      await bootstrap.connect();
      await bootstrap.db("admin").command({
        replSetInitiate: {
          _id: replicaSet,
          members: [{ _id: 0, host: "localhost:27017" }],
        },
      });
      for (let attempt = 0; attempt < 100; attempt++) {
        const hello = await bootstrap.db("admin").command({ hello: 1 });
        if (hello.isWritablePrimary === true) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await bootstrap.close();
    }
    client = new MongoClient(
      `${directUri}&replicaSet=${encodeURIComponent(replicaSet)}`,
      {
        monitorCommands: true,
        serverSelectionTimeoutMS: 30_000,
      },
    );
    await client.connect();
    client.on("commandStarted", ({ commandName, command }) => {
      if (!recording) return;
      if (commandName === "getMore") getMoreCount++;
      if (recordCommandDetails) commands.push({ name: commandName, command });
    });
  });

  beforeEach(async () => {
    recording = false;
    recordCommandDetails = true;
    getMoreCount = 0;
    commands = [];
    await client.db().dropDatabase();
  });

  afterAll(async () => {
    await client?.close();
    spawnSync("docker", ["rm", "--force", container]);
  });

  const prepareEmpty = async () => {
    expect(await source().prepare({ writersDrained: true })).toMatchObject({
      state: "ready",
      stage: "source",
      processed: 0,
    });
    await source().ensureReady();
  };

  const readGeneration = async (sourceGeneration: string) => {
    const rows = [];
    for (let shard = 0; shard < 16; shard++) {
      rows.push(
        ...(await source().readPage({
          sourceGeneration,
          shard,
          limit: 100,
        })),
      );
    }
    return rows;
  };

  it("commits direct source writes and rolls back every sidecar in a failed mixed transaction", async () => {
    await prepareEmpty();
    const first = createBundleEventRowFixture("910001", 100);
    await database().models.insights.append(first);

    const second = createBundleEventRowFixture("910002", 101);
    await expect(
      database().commit({
        changes: [
          {
            model: "bundles",
            operation: "insert",
            row: createBundleRowFixture("910002"),
          },
          { model: "insights", operation: "insert", row: second },
          {
            model: "bundlePatches",
            operation: "insert",
            row: createBundlePatchRowFixture(
              "910002",
              "missing-owner",
              "missing-base",
            ),
          },
        ],
      }),
    ).rejects.toThrow("references a missing bundle");

    const events = await client
      .db()
      .collection("bundle_events")
      .find({})
      .toArray();
    const ledger = await client
      .db()
      .collection(MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION)
      .find({}, { promoteLongs: false })
      .toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(first);
    expect(events[0]?._id).toBeInstanceOf(ObjectId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      _id: first.id,
      rawId: events[0]?._id,
      sequence: Long.ONE,
    });
    expect(await client.db().collection("bundles").countDocuments()).toBe(0);
    const secondClock = await client
      .db()
      .collection<{ _id: number; value: Long }>(
        MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
      )
      .findOne(
        { _id: mongoInsightsSourceShard(second.id) },
        { promoteLongs: false },
      );
    expect(secondClock?.value).toEqual(
      mongoInsightsSourceShard(first.id) === mongoInsightsSourceShard(second.id)
        ? Long.ONE
        : Long.ZERO,
    );

    let overflowSuffix = 910100;
    let overflow = createBundleEventRowFixture(String(overflowSuffix), 102);
    while (
      mongoInsightsSourceShard(overflow.id) ===
      mongoInsightsSourceShard(first.id)
    ) {
      overflow = createBundleEventRowFixture(String(++overflowSuffix), 102);
    }
    await client
      .db()
      .collection<{ _id: number; value: Long }>(
        MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
      )
      .updateOne(
        { _id: mongoInsightsSourceShard(overflow.id) },
        { $set: { value: Long.MAX_VALUE } },
      );
    await expect(
      database().models.insights.append(overflow),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    expect(await client.db().collection("bundle_events").countDocuments()).toBe(
      1,
    );
    expect(
      await client
        .db()
        .collection(MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION)
        .countDocuments(),
    ).toBe(1);
  });

  it("captures an immutable committed prefix and causally reads no later commit", async () => {
    await prepareEmpty();
    const first = createBundleEventRowFixture("920001", 100);
    const later = createBundleEventRowFixture("920002", 101);
    await database().models.insights.append(first);
    const firstGeneration = await source().capture();
    await database().models.insights.append(later);
    const secondGeneration = await source().capture();

    expect(
      (await readGeneration(firstGeneration)).map(({ event }) => event.id),
    ).toEqual([first.id]);
    expect(
      new Set(
        (await readGeneration(secondGeneration)).map(({ event }) => event.id),
      ),
    ).toEqual(new Set([first.id, later.id]));

    commands = [];
    recording = true;
    await source().readPage({
      sourceGeneration: secondGeneration,
      shard: mongoInsightsSourceShard(first.id),
      limit: 1,
    });
    recording = false;
    const transactionalRead = commands.find(
      ({ name, command }) =>
        name === "find" &&
        command.find === MONGO_INSIGHTS_SOURCE_STATE_COLLECTION &&
        command.autocommit === false,
    );
    expect(transactionalRead?.command.readConcern).toMatchObject({
      level: "snapshot",
      afterClusterTime: expect.anything(),
    });
  });

  it("reports the exact logical operation budget for a bounded two-row backfill", async () => {
    await client.db().createCollection("bundle_events", {
      collation: { locale: "en", strength: 2 },
    });
    const events = client.db().collection("bundle_events");
    const rows = [
      { ...createBundleEventRowFixture("925001", 100), _id: objectId(1) },
      { ...createBundleEventRowFixture("925002", 101), _id: objectId(2) },
    ];
    await events.insertMany(rows);
    await source().prepare({ writersDrained: true });
    for (let step = 0; step < 3; step++) {
      const progress = await source().runStep({
        maxItems: 2,
        maxRequests: 16,
      });
      if (progress.stage === "event-pages" && progress.state === "ready") break;
    }

    commands = [];
    recording = true;
    const progress = await source().runStep({
      maxItems: 2,
      maxRequests: 16,
    });
    recording = false;
    const logicalCommands = commands.filter(
      ({ name }) =>
        !["commitTransaction", "abortTransaction", "endSessions"].includes(
          name,
        ),
    );
    expect(progress).toMatchObject({
      state: "ready",
      stage: "source",
      processed: 2,
      itemsRead: 2,
      requests: 16,
    });
    expect(logicalCommands).toHaveLength(16);
    expect(getMoreCount).toBe(0);
    expect(await events.countDocuments()).toBe(2);
  });

  it("rejects a valid-shaped ledger collision without changing the raw row", async () => {
    const event = {
      ...createBundleEventRowFixture("926001", 100),
      _id: objectId(10),
    };
    await client.db().collection("bundle_events").insertOne(event);
    await source().prepare({ writersDrained: true });
    for (let step = 0; step < 3; step++) {
      const progress = await source().runStep({
        maxItems: 2,
        maxRequests: 16,
      });
      if (progress.stage === "event-pages" && progress.state === "ready") break;
    }
    const state = await client
      .db()
      .collection<{ _id: string }>("private_hot_updater_insights_source")
      .findOne({ _id: "source" });
    expect(state).not.toBeNull();
    await client
      .db()
      .collection<{
        _id: string;
        sourceId: string;
        shard: number;
        sequence: Long;
        rawId: ObjectId;
      }>(MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION)
      .insertOne({
        _id: event.id,
        sourceId: "00000000-0000-7000-8000-000000000123",
        shard: mongoInsightsSourceShard(event.id),
        sequence: Long.ONE,
        rawId: event._id,
      });

    await expect(
      source().runStep({ maxItems: 2, maxRequests: 16 }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    expect(
      await client.db().collection("bundle_events").findOne({
        _id: event._id,
      }),
    ).toEqual(event);
    expect(
      await client
        .db()
        .collection(MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION)
        .find({})
        .toArray(),
    ).toHaveLength(16);
  });

  it("fails closed when private source index or validator readiness is weakened", async () => {
    await prepareEmpty();
    await client.db().command({
      collMod: MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
      index: { name: "insights_source_sequence_idx", hidden: true },
      writeConcern: { w: "majority" },
    });
    await expect(source().ensureReady()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    await source().prepare({ writersDrained: true });
    await source().ensureReady();

    const sourceState = await client
      .db()
      .collection<{ _id: string; sourceId: string }>(
        "private_hot_updater_insights_source",
      )
      .findOne({ _id: "source" });
    expect(sourceState).not.toBeNull();
    const clockCollection = client
      .db()
      .collection<{ _id: number; sourceId: string; value: Long }>(
        MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
      );
    await clockCollection.deleteOne({ _id: 15 });
    await expect(source().ensureReady()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    await clockCollection.insertOne({
      _id: 15,
      sourceId: sourceState!.sourceId,
      value: Long.ZERO,
    });
    await source().ensureReady();

    await client.db().command({
      collMod: MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
      validationAction: "warn",
      writeConcern: { w: "majority" },
    });
    await expect(source().ensureReady()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
  });

  it("does not report source ready while event-page preparation is reopened", async () => {
    await prepareEmpty();
    await database().models.insights.append(
      createBundleEventRowFixture("927001", 100),
    );
    await client
      .db()
      .collection<{ _id: string }>("private_hot_updater_insights_preparation")
      .deleteOne({ _id: "event-pages" });

    expect(await source().prepare({ writersDrained: true })).toMatchObject({
      state: "auditing",
      stage: "event-pages",
    });
    await expect(source().ensureReady()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    let progress;
    for (let step = 0; step < 4; step++) {
      progress = await source().runStep({ maxItems: 2, maxRequests: 16 });
      if (progress.state === "ready" && progress.stage === "source") break;
    }
    expect(progress).toMatchObject({ state: "ready", stage: "source" });
    await source().ensureReady();
  });

  it("does not report first-install ready with incompatible private collation", async () => {
    await client.db().createCollection("private_hot_updater_insights_source", {
      collation: { locale: "en", strength: 2 },
    });
    await expect(
      source().prepare({ writersDrained: true }),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    await expect(source().ensureReady()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
  });

  it("backfills one existing maximum-size raw event without rewriting it", async () => {
    const event = nearLimitEvent("928001", 100);
    const raw = { ...event, _id: objectId(20) };
    expect(BSON.calculateObjectSize(raw)).toBe(16 * 1024 * 1024);
    await client.db().collection("bundle_events").insertOne(raw);
    await source().prepare({ writersDrained: true });

    recording = true;
    let progress;
    for (let step = 0; step < 10; step++) {
      progress = await source().runStep({ maxItems: 2, maxRequests: 16 });
      if (progress.state === "ready" && progress.stage === "source") break;
    }
    recording = false;
    expect(progress).toMatchObject({
      state: "ready",
      stage: "source",
      processed: 1,
    });
    expect(getMoreCount).toBe(0);
    const stored = await client
      .db()
      .collection("bundle_events")
      .findOne({ _id: raw._id });
    expect(BSON.calculateObjectSize(stored!)).toBe(16 * 1024 * 1024);
    expect(stored).toEqual(raw);
    expect(
      await client
        .db()
        .collection(MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION)
        .countDocuments(),
    ).toBe(1);
  });

  it("returns one valid near-16MiB event without getMore and reads at most one non-emitted raw row", async () => {
    await prepareEmpty();
    const large = nearLimitEvent("930001", 100);
    expect(BSON.calculateObjectSize({ ...large, _id: new ObjectId() })).toBe(
      16 * 1024 * 1024,
    );
    const shard = mongoInsightsSourceShard(large.id);
    let nextSuffix = 930002;
    let next = createBundleEventRowFixture(String(nextSuffix), 101);
    while (mongoInsightsSourceShard(next.id) !== shard) {
      next = createBundleEventRowFixture(String(++nextSuffix), 101);
    }
    await database().models.insights.append(large);
    await database().models.insights.append(next);
    const generation = await source().capture();

    commands = [];
    recording = true;
    const page = await source().readPage({
      sourceGeneration: generation,
      shard,
      limit: 100,
    });
    recording = false;
    const rawReads = commands.filter(
      ({ name, command }) =>
        name === "find" && command.find === "bundle_events",
    );
    const ledgerReads = commands.filter(
      ({ name, command }) =>
        name === "find" &&
        command.find === MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
    );
    expect(page).toHaveLength(1);
    expect(page[0]?.event).toEqual(large);
    const returnedEventBytes = page.reduce(
      (bytes, { event }) => bytes + BSON.calculateObjectSize(event),
      0,
    );
    expect(returnedEventBytes).toBe(16 * 1024 * 1024 - 17);
    expect(returnedEventBytes).toBeLessThanOrEqual(
      MONGO_INSIGHTS_SOURCE_PAGE_MAX_BYTES,
    );
    expect(rawReads).toHaveLength(2);
    expect(ledgerReads).toHaveLength(1);
    expect(getMoreCount).toBe(0);
    expect(rawReads.every(({ command }) => command.singleBatch === true)).toBe(
      true,
    );
    const continuation = await source().readPage({
      sourceGeneration: generation,
      shard,
      afterSequence: page[0]!.sequence,
      limit: 100,
    });
    expect(continuation.map(({ event }) => event.id)).toEqual([next.id]);
  }, 60_000);

  it("backfills 50,001 immutable rows in bounded steps and serves the source index", async () => {
    const events = client.db().collection("bundle_events");
    for (let offset = 0; offset < 50_001; offset += 500) {
      await events.insertMany(
        Array.from({ length: Math.min(500, 50_001 - offset) }, (_, index) => ({
          ...createBundleEventRowFixture(
            String(100_000 + offset + index),
            offset + index,
          ),
          _id: objectId(offset + index),
          extension: { retained: true },
        })),
      );
    }
    expect(await source().prepare({ writersDrained: true })).toMatchObject({
      state: "auditing",
    });
    let progress;
    let sourceSteps = 0;
    commands = [];
    recordCommandDetails = false;
    recording = true;
    for (let step = 0; step < 900; step++) {
      progress = await source().runStep({ maxItems: 200, maxRequests: 610 });
      expect(progress.itemsRead).toBeLessThanOrEqual(200);
      expect(progress.requests).toBeLessThanOrEqual(610);
      if (progress.stage === "source") sourceSteps++;
      if (progress.state === "ready" && progress.stage === "source") break;
    }
    recording = false;
    expect(progress).toMatchObject({
      state: "ready",
      stage: "source",
      processed: 50_001,
    });
    expect(sourceSteps).toBeGreaterThan(250);
    expect(getMoreCount).toBe(0);
    expect(await events.countDocuments()).toBe(50_001);
    expect(await events.findOne({ _id: objectId(25_000) })).toHaveProperty(
      "extension.retained",
      true,
    );

    const generation = await source().capture();
    const decoded = JSON.parse(generation) as [
      number,
      string,
      string[],
      number[],
    ];
    const shard = decoded[2].findIndex((value) => BigInt(value) > 100n);
    const upper = Long.fromString(decoded[2][shard]!);
    const publicPage = await source().readPage({
      sourceGeneration: generation,
      shard,
      limit: 1,
    });
    expect(publicPage).toHaveLength(1);
    expect(publicPage[0]?.event).not.toHaveProperty("_id");
    expect(publicPage[0]?.event).not.toHaveProperty("extension");
    const plan = await client.db().command({
      explain: {
        find: MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
        filter: {
          sourceId: decoded[1],
          shard,
          sequence: { $gt: Long.ZERO, $lte: upper },
        },
        hint: "insights_source_sequence_idx",
        sort: { sequence: 1 },
        limit: 100,
        singleBatch: true,
      },
      verbosity: "executionStats",
    });
    expect(findStages(plan.executionStats.executionStages)).toContain("IXSCAN");
    expect(findStages(plan.executionStats.executionStages)).not.toContain(
      "COLLSCAN",
    );
    expect(findStages(plan.executionStats.executionStages)).not.toContain(
      "SORT",
    );
    expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(100);
    expect(plan.executionStats.totalKeysExamined).toBeLessThanOrEqual(100);
  }, 180_000);
});
