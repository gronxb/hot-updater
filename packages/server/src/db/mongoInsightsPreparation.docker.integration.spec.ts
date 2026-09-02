import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import {
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_EVENT_MAX_BYTES,
} from "@hot-updater/plugin-core/internal";
import { BSON, Collection, MongoClient, type Document } from "mongodb";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { findOpenPort } from "../../../test-utils/src/runtimeProcess";
import { createMongoInsightsPreparation } from "./mongoInsightsPreparation";
import { createMongoInsightsSource } from "./mongoInsightsSource";

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000e004";

const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};
const encode = (value: unknown) =>
  BSON.EJSON.stringify(value, { relaxed: false });
const objectId = (value: number) =>
  new BSON.ObjectId(value.toString(16).padStart(24, "0"));
const oversizedExtension = (suffix: string, receivedAtMs: number) => {
  const extension: string[] = [];
  const event = {
    ...createBundleEventRowFixture(suffix, receivedAtMs),
    extension,
  };
  while (true) {
    const remaining =
      INSIGHTS_EVENT_MAX_BYTES - getCanonicalInsightsJsonByteLength(event);
    const overhead = extension.length === 0 ? 2 : 3;
    if (remaining <= overhead) break;
    extension.push("x".repeat(Math.min(1024, remaining - overhead)));
  }
  return [...extension, "x"];
};
describe("MongoDB durable native-event preparation", () => {
  const container = `hot-updater-mongo-preparation-${randomUUID().slice(0, 8)}`;
  let client: MongoClient;
  let uri: string;
  let commands: Document[] = [];
  let recording = false;
  const events = () => client.db().collection("bundle_events");
  const states = () =>
    client.db().collection("private_hot_updater_insights_preparation");
  const tools = () => createMongoInsightsPreparation(client);

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
      "/data/db:rw,size=512m",
      "--tmpfs",
      "/data/configdb:rw,size=16m",
      "-p",
      `127.0.0.1:${port}:27017`,
      "mongo:7-jammy",
      "--bind_ip_all",
      "--wiredTigerCacheSizeGB",
      "0.25",
      "--quiet",
    ]);
    uri = `mongodb://127.0.0.1:${port}/insights_preparation`;
    client = new MongoClient(uri, {
      monitorCommands: true,
      serverSelectionTimeoutMS: 30_000,
    });
    await client.connect();
    client.on("commandStarted", (event) => {
      if (
        recording &&
        [
          "find",
          "getMore",
          "killCursors",
          "listCollections",
          "update",
        ].includes(event.commandName)
      )
        commands.push(event.command);
    });
  });
  beforeEach(async () => {
    recording = false;
    commands = [];
    await client.db().dropDatabase();
  });
  afterAll(async () => {
    await client?.close();
    spawnSync("docker", ["rm", "--force", container]);
  });

  const insert = async (id: unknown, suffix: number, change: Document = {}) => {
    // The command form preserves explicit legacy BSON values such as null.
    const result = await client.db().command({
      insert: "bundle_events",
      documents: [
        {
          ...createBundleEventRowFixture(String(suffix), suffix),
          _id: typeof id === "number" ? objectId(id) : id,
          ...change,
        },
      ],
    });
    const [error] = result.writeErrors ?? [];
    if (error)
      throw Object.assign(new Error(error.errmsg), { code: error.code });
  };
  const finish = async (maxItems = 1000) => {
    for (let step = 0; step < 100; step++) {
      const result = await tools().runStep({ maxItems, maxRequests: 5 });
      if (result.state === "ready") return result;
    }
    throw new Error("Fixture audit failed to finish within its bounded steps");
  };
  const digest = async () => {
    const hash = createHash("sha256");
    for await (const row of events()
      .find({})
      .hint("_id_")
      .sort({ _id: 1 })
      .batchSize(400))
      hash.update(encode(row));
    return hash.digest("hex");
  };

  it("requires preparation and treats an empty prepared database idempotently", async () => {
    await expect(tools().ensureReady()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    expect(await tools().prepare({ writersDrained: true })).toEqual({
      state: "ready",
      processed: 0,
    });
    const first = await states().findOne({ _id: "event-pages" } as never);
    expect(await tools().prepare({ writersDrained: true })).toEqual({
      state: "ready",
      processed: 0,
    });
    expect(await states().findOne({ _id: "event-pages" } as never)).toEqual(
      first,
    );
    await tools().ensureReady();
  });

  it("does not fall back to non-atomic source preparation on standalone MongoDB", async () => {
    await expect(
      createMongoInsightsSource(client, insightsDatabaseNamespace).prepare({
        writersDrained: true,
      }),
    ).rejects.toMatchObject({ code: 20 });
    expect(
      await client
        .db()
        .collection("private_hot_updater_insights_source")
        .countDocuments(),
    ).toBe(0);
  });

  it("uses primary-local reads and acknowledged fences independently of caller defaults", async () => {
    await insert(0, 90);
    const inherited = new MongoClient(uri, {
      monitorCommands: true,
      readPreference: "secondaryPreferred",
      readConcern: { level: "majority" },
      writeConcern: { w: 0 },
    });
    const observed: Document[] = [];
    inherited.on("commandStarted", ({ command }) => observed.push(command));
    try {
      await inherited.connect();
      const preparation = createMongoInsightsPreparation(inherited);
      await preparation.prepare({ writersDrained: true });
      let result;
      for (let step = 0; step < 5; step++) {
        result = await preparation.runStep({ maxItems: 2, maxRequests: 5 });
        if (result.state === "ready") break;
      }
      expect(result).toMatchObject({ state: "ready", processed: 1 });
      await preparation.ensureReady();
      const reads = observed.filter((command) => "find" in command);
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        expect(read.readConcern).toEqual({ level: "local" });
        expect(read.$readPreference?.mode ?? "primary").toBe("primary");
      }
      const writes = observed.filter(
        (command) =>
          "insert" in command ||
          "update" in command ||
          "collMod" in command ||
          "createIndexes" in command,
      );
      expect(writes.some((command) => "collMod" in command)).toBe(true);
      expect(writes.some((command) => "update" in command)).toBe(true);
      for (const write of writes)
        expect(write.writeConcern).toMatchObject({ w: "majority" });
      expect(inherited.db().readPreference.mode).toBe("secondaryPreferred");
      expect(inherited.db().readConcern?.level).toBe("majority");
      expect(inherited.db().writeConcern?.w).toBe(0);
    } finally {
      await inherited.close();
    }
  });

  it.each([
    [{ locale: "simple" }, "legacy-id"],
    [{ locale: "en", strength: 2, numericOrdering: true }, new BSON.Int32(2)],
    [{ locale: "simple" }, new BSON.MaxKey()],
  ])(
    "audits an existing non-ObjectId under %j collation without rewriting it",
    async (collation, legacyId) => {
      await client.db().createCollection("bundle_events", { collation });
      await insert(legacyId, 100);
      const original = await digest();
      await tools().prepare({ writersDrained: true });
      expect(await finish(2)).toMatchObject({ state: "ready", processed: 1 });
      await tools().ensureReady();
      expect(await digest()).toBe(original);
    },
  );

  it("keeps each audit step bounded above 50,000 rows and retains raw extensions", async () => {
    await client.db().createCollection("bundle_events");
    for (let offset = 0; offset < 50_001; offset += 400) {
      const documents = Array.from(
        { length: Math.min(400, 50_001 - offset) },
        (_, index) => ({
          ...createBundleEventRowFixture(
            String(100_000 + offset + index),
            offset + index,
          ),
          _id: objectId(offset + index),
          extension: { keep: true },
        }),
      );
      await client.db().command({ insert: "bundle_events", documents });
    }
    const original = await digest();
    await tools().prepare({ writersDrained: true });
    let result;
    for (let step = 0; step < 300; step++) {
      commands = [];
      recording = true;
      result = await tools().runStep({ maxItems: 200, maxRequests: 5 });
      recording = false;
      expect(commands).toHaveLength(result.itemsRead === 0 ? 4 : 5);
      expect(result.itemsRead).toBeLessThanOrEqual(200);
      expect(commands.filter((command) => "getMore" in command)).toHaveLength(
        0,
      );
      const reads = commands.filter(
        (command) => command.find === "bundle_events",
      );
      expect(reads).toHaveLength(result.itemsRead === 0 ? 1 : 2);
      expect(reads[0]?.projection).toHaveProperty("documentBytes");
      if (result.itemsRead > 0)
        expect(reads[1]).not.toHaveProperty("projection");
      if (result.state === "ready") break;
    }
    expect(result).toMatchObject({ state: "ready", processed: 50_001 });
    expect(await digest()).toBe(original);
  }, 60_000);

  it("fails durably on an oversized raw extension without rewriting it", async () => {
    await insert(0, 800, {
      extension: oversizedExtension("800", 800),
    });
    const original = await digest();
    await tools().prepare({ writersDrained: true });
    commands = [];
    recording = true;
    await expect(finish(100)).rejects.toMatchObject({ code: "invalid-result" });
    recording = false;
    expect(commands).toHaveLength(9);
    expect(commands.filter((command) => "getMore" in command)).toHaveLength(0);
    expect(
      await states().findOne({ _id: "event-pages" } as never),
    ).toMatchObject({ phase: "failed", processed: 0 });
    expect(await digest()).toBe(original);
  });

  it("rejects a hostile legacy document from BSON metadata before reading its payload", async () => {
    await insert(0, 801, { extension: "x".repeat(5 * 1024 * 1024) });
    const original = await digest();
    await tools().prepare({ writersDrained: true });
    commands = [];
    recording = true;
    await tools().runStep({ maxItems: 100, maxRequests: 5 });
    await expect(
      tools().runStep({ maxItems: 100, maxRequests: 5 }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    recording = false;
    const eventReads = commands.filter(
      (command) => command.find === "bundle_events",
    );
    expect(eventReads).toHaveLength(2);
    expect(
      eventReads.every((command) =>
        Object.hasOwn(command.projection ?? {}, "documentBytes"),
      ),
    ).toBe(true);
    expect(commands.filter((command) => "getMore" in command)).toHaveLength(0);
    expect(
      await states().findOne({ _id: "event-pages" } as never),
    ).toMatchObject({ phase: "failed", processed: 0 });
    expect(await digest()).toBe(original);
  });

  it.each([new BSON.MinKey(), null, new BSON.MaxKey()])(
    "audits a singleton legacy BSON boundary %j without rewriting it",
    async (id) => {
      await insert(id, 200);
      const original = await digest();
      await tools().prepare({ writersDrained: true });
      expect(await finish(2)).toMatchObject({ state: "ready", processed: 1 });
      await tools().ensureReady();
      expect(await digest()).toBe(original);
    },
  );

  it("does not skip the successor when its checkpoint or upper row is deleted", async () => {
    for (let id = 0; id < 5; id++) await insert(id, 300 + id);
    await tools().prepare({ writersDrained: true });
    expect(
      await tools().runStep({ maxItems: 3, maxRequests: 5 }),
    ).toMatchObject({ processed: 3 });
    await client.db().command({
      delete: "bundle_events",
      deletes: [
        { q: { _id: objectId(2) }, limit: 1 },
        { q: { _id: objectId(4) }, limit: 1 },
      ],
    });
    expect(await finish(3)).toMatchObject({ state: "ready", processed: 4 });
    expect(
      (await events().find({}).sort({ _id: 1 }).limit(10).toArray()).map(
        (row) => row._id,
      ),
    ).toEqual([objectId(0), objectId(1), objectId(3)]);
  });

  it.each([
    { id: "noncanonical" },
    { id: "00000000-0000-4000-8000-000000000401" },
    { received_at_ms: 1.5 },
    { received_at_ms: Number.NaN },
    { install_id: ["multikey"] },
    { type: "UNCHANGED" },
  ])(
    "fails safely on old invalid rows and leaves the raw data unchanged: %j",
    async (change) => {
      await insert(0, 400);
      await insert(1, 401, change);
      const original = await digest();
      await tools().prepare({ writersDrained: true });
      await expect(finish(3)).rejects.toMatchObject({ code: "invalid-result" });
      expect(
        await states().findOne({ _id: "event-pages" } as never),
      ).toMatchObject({ phase: "failed" });
      await expect(tools().ensureReady()).rejects.toMatchObject({
        code: "INSIGHTS_QUERY_NOT_READY",
      });
      expect(await digest()).toBe(original);
    },
  );

  it("preserves custom validators and fences invalid legacy inserts and updates before audit", async () => {
    const custom = { tenant: { $eq: "kept" } };
    await client.db().createCollection("bundle_events", {
      validator: custom,
      validationLevel: "strict",
      validationAction: "error",
    });
    await insert(0, 500, { tenant: "kept" });
    await tools().prepare({ writersDrained: true });
    for (const change of [
      { tenant: "wrong" },
      { id: "not-uuid" },
      { received_at_ms: 0.5 },
      { received_at_ms: BSON.Decimal128.fromString("4") },
    ]) {
      await expect(
        insert(1, 501, { tenant: "kept", ...change }),
      ).rejects.toMatchObject({ code: 121 });
    }
    await expect(
      events().updateOne({ _id: objectId(0) } as never, {
        $set: { received_at_ms: 1.5 },
      }),
    ).rejects.toMatchObject({ code: 121 });
    await insert(1, 502, {
      tenant: "kept",
      received_at_ms: BSON.Long.fromNumber(Number.MAX_SAFE_INTEGER),
    });
    await finish(3);
    await tools().ensureReady();
    const metadata = await events().options();
    expect(metadata.validationAction).toBe("error");
    expect(metadata.validationLevel).toBe("strict");
    expect(metadata.validator.$and[0]).toEqual(custom);
  });

  it("uses CAS so concurrent audit steps cannot double-count or advance stale work", async () => {
    for (let id = 0; id < 6; id++) await insert(id, 600 + id);
    await tools().prepare({ writersDrained: true });
    const original = Collection.prototype.updateOne;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = vi
      .spyOn(Collection.prototype, "updateOne")
      .mockImplementation(
        async function (this: Collection, filter, value, options) {
          if (
            this.collectionName === "private_hot_updater_insights_preparation"
          ) {
            arrivals++;
            if (arrivals === 2) release();
            await barrier;
          }
          return original.call(this, filter, value, options);
        },
      );
    let results;
    try {
      results = await Promise.allSettled([
        tools().runStep({ maxItems: 3, maxRequests: 5 }),
        tools().runStep({ maxItems: 3, maxRequests: 5 }),
      ]);
    } finally {
      update.mockRestore();
    }
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      await states().findOne({ _id: "event-pages" } as never),
    ).toMatchObject({ processed: 3 });
    expect(await finish(3)).toMatchObject({ state: "ready", processed: 6 });
  });

  it("keeps failed index preparation non-ready and retries without growing the validator", async () => {
    await insert(0, 900);
    await insert(1, 900);
    const original = await digest();
    await expect(
      tools().prepare({ writersDrained: true }),
    ).rejects.toMatchObject({ code: 11000 });
    const validator = (await events().options()).validator;
    for (let retry = 0; retry < 2; retry++) {
      await expect(
        tools().prepare({ writersDrained: true }),
      ).rejects.toMatchObject({ code: 11000 });
      expect((await events().options()).validator).toEqual(validator);
      expect(
        await states().findOne({ _id: "event-pages" } as never),
      ).toMatchObject({ phase: "failed", processed: 0 });
      await expect(tools().ensureReady()).rejects.toMatchObject({
        code: "INSIGHTS_QUERY_NOT_READY",
      });
    }
    expect(await digest()).toBe(original);
  });

  it("invalidates readiness after validator weakening or collection replacement", async () => {
    await tools().prepare({ writersDrained: true });
    const validator = (await events().options()).validator;
    for (let attempt = 0; attempt < 3; attempt++) {
      await client
        .db()
        .command({ collMod: "bundle_events", validationAction: "warn" });
      await expect(tools().ensureReady()).rejects.toMatchObject({
        code: "INSIGHTS_QUERY_NOT_READY",
      });
      await tools().prepare({ writersDrained: true });
      expect((await events().options()).validator).toEqual(validator);
    }
    await events().drop();
    await client.db().createCollection("bundle_events");
    await expect(tools().ensureReady()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
  });
});
