import net from "node:net";
import path from "node:path";

import { type BundleEventRow } from "@hot-updater/plugin-core";
import { execa } from "execa";
import { MongoClient, type CommandStartedEvent, type Document } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { mongoAdapter } from "./mongodb";

const availablePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate MongoDB test port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

describe("MongoDB native Insights storage", () => {
  let client: MongoClient;
  let composeEnvironment: Record<string, string>;
  const composeFile = path.resolve(
    import.meta.dirname,
    "../../../../examples-server/hono-mongodb/docker-compose.yml",
  );
  const compose = (args: string[]) =>
    execa("docker", ["compose", "-f", composeFile, ...args], {
      env: composeEnvironment,
    });
  const insights = () => mongoAdapter({ client }).models.insights;
  const record = (event: BundleEventRow) =>
    insights().recordEvent({
      event,
    });

  const measure = async (read: () => Promise<unknown>) => {
    let pipeline: Document[] | undefined;
    const capture = (event: CommandStartedEvent) => {
      if (event.command.aggregate === "bundle_event_heads")
        pipeline = event.command.pipeline;
    };
    client.on("commandStarted", capture);
    let result: unknown;
    try {
      result = await read();
    } finally {
      client.off("commandStarted", capture);
    }
    expect(pipeline).toBeDefined();
    const plan = await client
      .db()
      .collection("bundle_event_heads")
      .aggregate(pipeline!, { collation: { locale: "simple" } })
      .explain("executionStats");
    expect(JSON.stringify(plan)).not.toContain('"stage":"COLLSCAN"');
    const cursor = plan.stages?.find(
      (stage: Record<string, unknown>) => "$cursor" in stage,
    )?.$cursor;
    const stats = plan.executionStats ?? cursor?.executionStats;
    const lookup = plan.stages?.find(
      (stage: Record<string, unknown>) => "$lookup" in stage,
    );
    return {
      result,
      keysExamined: stats.totalKeysExamined + (lookup?.totalKeysExamined ?? 0),
      docsExamined: stats.totalDocsExamined + (lookup?.totalDocsExamined ?? 0),
    };
  };

  beforeAll(async () => {
    const port = await availablePort();
    composeEnvironment = {
      COMPOSE_PROJECT_NAME: `hot-updater-insights-${process.pid}`,
      HOT_UPDATER_E2E_MONGODB_PORT: String(port),
    };
    await compose(["up", "-d", "--wait"]);
    client = new MongoClient(
      `mongodb://127.0.0.1:${port}/insights_native?replicaSet=rs0&directConnection=true`,
      { monitorCommands: true },
    );
    await client.connect();
    const adapter = mongoAdapter({ client });
    await (await adapter.createMigrator!().migrateToLatest()).execute();
  }, 120_000);

  beforeEach(async () => {
    await client.db().collection("bundle_events").deleteMany({});
    await client.db().collection("bundle_event_heads").deleteMany({});
  });

  afterAll(async () => {
    await client?.close();
    if (composeEnvironment) await compose(["down", "-v", "--remove-orphans"]);
  }, 60_000);

  it("preserves latest state after a native event validation error", async () => {
    const previous = {
      ...createBundleEventRowFixture("801", 100),
      user_id: "original",
    };
    await record(previous);
    await client.db().command({
      collMod: "bundle_events",
      validator: { user_id: { $ne: "reject" } },
    });
    const failed = {
      ...createBundleEventRowFixture("802", 200),
      install_id: previous.install_id,
      user_id: "reject",
    };
    try {
      await expect(record(failed)).rejects.toThrow();
      expect(
        await client.db().collection("bundle_events").countDocuments({}),
      ).toBe(1);
      await expect(
        insights().findLatestEvents({ installId: previous.install_id }),
      ).resolves.toEqual([previous]);
    } finally {
      await client.db().command({ collMod: "bundle_events", validator: {} });
    }
    await record(failed);
    await record(failed);
    expect(
      await client.db().collection("bundle_events").countDocuments({}),
    ).toBe(2);
    await expect(
      insights().findLatestEvents({ installId: previous.install_id }),
    ).resolves.toEqual([failed]);
  });

  it("retries native conflicts without dropping events or letting duplicate IDs rewrite state", async () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      ...createBundleEventRowFixture(String(810 + index), 100),
      install_id: "concurrent-installation",
      user_id: index === 11 ? null : "old-user",
    }));
    await Promise.all(events.map(record));
    const winner = events.at(-1)!;
    await Promise.all(Array.from({ length: 4 }, () => record(winner)));
    const conflictingDuplicate = {
      ...events[0]!,
      install_id: "different-installation",
      received_at_ms: 1000,
    };
    await record(conflictingDuplicate);
    expect(
      await client.db().collection("bundle_events").countDocuments({}),
    ).toBe(12);
    await expect(
      insights().findLatestEvents({ installId: winner.install_id }),
    ).resolves.toEqual([winner]);
    await expect(
      insights().findLatestEvents({
        installId: conflictingDuplicate.install_id,
      }),
    ).resolves.toEqual([]);
    await expect(
      insights().findLatestEvents({ userId: "old-user", limit: 10 }),
    ).resolves.toEqual([]);
  });

  it("accepts concurrent retries of a previously unseen event ID exactly once", async () => {
    const event = createBundleEventRowFixture("825", 100);
    await Promise.all(Array.from({ length: 12 }, () => record(event)));
    expect(
      await client.db().collection("bundle_events").countDocuments({}),
    ).toBe(1);
    await expect(
      insights().findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([event]);
  });

  it("atomically moves scope membership while rejecting old or duplicate state", async () => {
    const previous = {
      ...createBundleEventRowFixture("840", 100),
      user_id: "old",
    };
    const current = {
      ...previous,
      id: createBundleEventRowFixture("842", 200).id,
      received_at_ms: 200,
      user_id: null,
      channel: "preview",
    };
    await record(previous);
    const heads = client.db().collection("bundle_event_heads");
    await client.db().command({
      collMod: "bundle_event_heads",
      validator: { channel: { $ne: "preview" } },
    });
    try {
      await expect(record(current)).rejects.toThrow();
      expect(
        await client.db().collection("bundle_events").countDocuments({}),
      ).toBe(1);
      await expect(
        insights().findLatestEvents({ installId: current.install_id }),
      ).resolves.toEqual([previous]);
    } finally {
      await client
        .db()
        .command({ collMod: "bundle_event_heads", validator: {} });
    }
    await record(current);
    await record({ ...current, channel: "duplicate", received_at_ms: 300 });
    await record({
      ...previous,
      id: createBundleEventRowFixture("841", 200).id,
      received_at_ms: 200,
    });
    await expect(
      insights().findLatestEvents({ userId: "old", limit: 10 }),
    ).resolves.toEqual([]);
    for (const [channel, expected] of [
      ["production", 0],
      ["preview", 1],
      ["duplicate", 0],
    ] as const)
      await expect(
        insights().countLatestEvents({ platform: "ios", channel, sinceMs: 0 }),
      ).resolves.toBe(expected);
    expect(
      Object.keys((await heads.findOne({ install_id: current.install_id }))!)
        .filter((key) => key !== "_id")
        .sort(),
    ).toEqual([
      "channel",
      "from_bundle_id",
      "id",
      "install_id",
      "platform",
      "received_at_ms",
      "to_bundle_id",
      "type",
      "user_id",
    ]);
  });

  it("keeps native latest reads bounded as history and unrelated scopes grow", async () => {
    const events = Array.from({ length: 24 }, (_, index) => ({
      ...createBundleEventRowFixture(String(10000 + index), 1000),
      install_id: `installation-${String(index).padStart(3, "0")}`,
      user_id: "current",
    }));
    await Promise.all(events.map(record));
    const reads = async () => ({
      user: await measure(() =>
        insights().findLatestEvents({ userId: "current", limit: 10 }),
      ),
      scope: await measure(() =>
        insights().countLatestEvents({
          platform: "ios",
          channel: "production",
          sinceMs: 500,
        }),
      ),
      bundle: await measure(() =>
        insights().countLatestEvents({
          platform: "ios",
          channel: "production",
          sinceMs: 500,
          bundle: [
            {
              field: "to_bundle_id",
              value: events[0]!.to_bundle_id,
              types: ["UPDATE_APPLIED"],
            },
          ],
        }),
      ),
    });
    const before = await reads();
    // Older accepted events do not advance heads. Bulk seed the immutable
    // history so this measurement isolates read cost from transaction timing.
    await client
      .db()
      .collection("bundle_events")
      .insertMany(
        Array.from({ length: 2400 }, (_, index) => ({
          ...events[index % events.length]!,
          id: createBundleEventRowFixture(String(20000 + index), 1).id,
          received_at_ms: index % 100,
          user_id: "previous",
        })),
      );
    const afterHistory = await reads();
    await Promise.all(
      Array.from({ length: 240 }, (_, index) =>
        record({
          ...createBundleEventRowFixture(String(30000 + index), 1000),
          install_id: `other-${index}`,
          user_id: "other",
          channel: "other",
        }),
      ),
    );
    const afterScopes = await reads();
    for (const sample of [before, afterHistory, afterScopes]) {
      expect(sample.user.result).toEqual(events.slice(0, 10));
      expect(sample.user.keysExamined).toBeLessThanOrEqual(22);
      expect(sample.user.docsExamined).toBeLessThanOrEqual(20);
      expect(sample.scope.result).toBe(events.length);
      expect(sample.scope.keysExamined).toBeLessThanOrEqual(events.length + 1);
      expect(sample.scope.docsExamined).toBeLessThanOrEqual(events.length);
      expect(sample.bundle.result).toBe(1);
      expect(sample.bundle.keysExamined).toBeLessThanOrEqual(2);
      expect(sample.bundle.docsExamined).toBeLessThanOrEqual(1);
    }
    expect(afterHistory).toEqual(before);
    await expect(
      insights().findLatestEvents({ userId: "previous", limit: 10 }),
    ).resolves.toEqual([]);
    const metrics = (sample: Awaited<ReturnType<typeof reads>>) =>
      Object.fromEntries(
        Object.entries(sample).map(
          ([query, { keysExamined, docsExamined }]) => [
            query,
            { keysExamined, docsExamined },
          ],
        ),
      );
    console.info(
      "MongoDB latest read growth",
      JSON.stringify({
        before: metrics(before),
        afterHistory: metrics(afterHistory),
        afterScopes: metrics(afterScopes),
        historyEventsAdded: 2400,
        unrelatedInstallationsAdded: 240,
      }),
    );
  });

  it("uses raw recovery predicates consistently in native counts and indexed lists", async () => {
    const applied = createBundleEventRowFixture("831", 100);
    const recovered: BundleEventRow = {
      ...createBundleEventRowFixture("832", 200),
      type: "RECOVERED",
      metadata: {
        ...createBundleEventRowFixture("832", 200).metadata,
        update_strategy: "appVersion",
      },
      install_id: applied.install_id,
      from_bundle_id: applied.to_bundle_id,
      to_bundle_id: applied.from_bundle_id!,
    };
    await record(applied);
    await record(recovered);
    const filter = {
      type: "RECOVERED" as const,
      platform: "ios" as const,
      channel: "production",
      fromBundleId: applied.to_bundle_id,
    };
    await expect(
      insights().countEvents({ filter, sinceMs: 200, beforeReceivedAtMs: 201 }),
    ).resolves.toBe(1);
    await expect(
      insights().listEvents({
        filter: { kind: "bundle", ...filter },
        sinceMs: 200,
        beforeReceivedAtMs: 201,
        limit: 10,
      }),
    ).resolves.toEqual([recovered]);
    await expect(
      insights().countEvents({ filter, sinceMs: 100, beforeReceivedAtMs: 200 }),
    ).resolves.toBe(0);
    await expect(
      insights().countLatestEvents({
        platform: "ios",
        channel: "production",
        bundle: [
          {
            field: "to_bundle_id",
            value: applied.to_bundle_id,
            types: ["UPDATE_APPLIED", "RECOVERED", "UNCHANGED"],
          },
        ],
        sinceMs: 0,
      }),
    ).resolves.toBe(0);
    const explanation = await client
      .db()
      .collection("bundle_events")
      .find({
        type: "RECOVERED",
        platform: "ios",
        channel: "production",
        from_bundle_id: applied.to_bundle_id,
        received_at_ms: { $gte: 200, $lt: 201 },
      })
      .collation({ locale: "simple" })
      .sort({ received_at_ms: -1, id: -1 })
      .hint("bundle_events_from_bundle_idx")
      .explain("executionStats");
    expect(explanation.executionStats.nReturned).toBe(1);
    expect(explanation.executionStats.totalKeysExamined).toBeLessThanOrEqual(2);
  });

  it("uses native bundle indexes for rare, common, absent, and overlapping predicates", async () => {
    const rare = createBundleEventRowFixture("40000", 1000).to_bundle_id;
    const common = createBundleEventRowFixture("40001", 1000).to_bundle_id;
    const absent = createBundleEventRowFixture("40002", 1000).to_bundle_id;
    const events = Array.from({ length: 1000 }, (_, index) => {
      const bundleId = index === 0 ? rare : common;
      return {
        ...createBundleEventRowFixture(String(50000 + index), 1000),
        from_bundle_id: bundleId,
        to_bundle_id: bundleId,
      };
    });
    // Seed a consistent large read fixture; transaction correctness is covered
    // above. The index contains only the access fields used by production.
    await client.db().collection("bundle_events").insertMany(events);
    await client
      .db()
      .collection("bundle_event_heads")
      .insertMany(
        events.map((event) => ({
          install_id: event.install_id,
          id: event.id,
          received_at_ms: event.received_at_ms,
          user_id: event.user_id,
          platform: event.platform,
          channel: event.channel,
          type: event.type,
          from_bundle_id: event.from_bundle_id,
          to_bundle_id: event.to_bundle_id,
        })),
      );
    const count = (bundleId: string, overlap = false) =>
      measure(() =>
        insights().countLatestEvents({
          platform: "ios",
          channel: "production",
          sinceMs: 500,
          bundle: [
            {
              field: "from_bundle_id",
              value: bundleId,
              types: overlap ? ["UPDATE_APPLIED"] : ["UPDATE_DOWNLOADED"],
            },
            {
              field: "to_bundle_id",
              value: bundleId,
              types: ["UNCHANGED", "UPDATE_APPLIED", "RECOVERED"],
            },
          ],
        }),
      );
    const samples = {
      rare: await count(rare),
      common: await count(common),
      absent: await count(absent),
      rareOverlap: await count(rare, true),
      commonOverlap: await count(common, true),
    };
    for (const query of [samples.rare, samples.rareOverlap]) {
      expect(query.result).toBe(1);
      expect(query.keysExamined).toBeLessThanOrEqual(8);
      expect(query.docsExamined).toBeLessThanOrEqual(1);
    }
    expect(samples.absent.result).toBe(0);
    expect(samples.absent.keysExamined).toBeLessThanOrEqual(4);
    expect(samples.absent.docsExamined).toBe(0);
    for (const query of [samples.common, samples.commonOverlap]) {
      expect(query.result).toBe(999);
      expect(query.keysExamined).toBeLessThanOrEqual(2 * 999 + 8);
      expect(query.docsExamined).toBeLessThanOrEqual(1000);
    }
    console.info("MongoDB native bundle selectivity", JSON.stringify(samples));
  });
});
