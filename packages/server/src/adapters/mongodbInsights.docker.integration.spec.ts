import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
  BundleEventRow,
  InsightsEventPageInput,
} from "@hot-updater/plugin-core";
import { createInsightsEventPageCursor } from "@hot-updater/plugin-core/internal";
import { MongoClient, type Collection, type Document } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { findOpenPort } from "../../../test-utils/src/runtimeProcess";
import {
  createMongoInsightsQueries,
  mongoInsightsEventIndexes,
} from "./mongodbInsights";

const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};
const installId = "target-installation";
const bundleId = createBundleEventRowFixture("1", 0).to_bundle_id;
const movement = (index: number): BundleEventRow => ({
  ...createBundleEventRowFixture(String(200_000 + index), 60_000),
  type: index % 2 === 0 ? "UPDATE_APPLIED" : "RECOVERED",
  install_id: installId,
  from_bundle_id: bundleId,
  to_bundle_id: bundleId,
  update_strategy: "appVersion",
});
const activity = (index: number): BundleEventRow => {
  const row = {
    ...createBundleEventRowFixture(String(100_000 + index), index),
    install_id: installId,
    to_bundle_id: bundleId,
  };
  return index % 2 === 0
    ? { ...row, type: "UNCHANGED", from_bundle_id: null, update_strategy: null }
    : {
        ...row,
        type: "RELEASE_ADOPTED",
        from_bundle_id: bundleId,
        update_strategy: "appVersion",
      };
};
const stages = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(stages);
  if (typeof value !== "object" || value === null) return [];
  return [
    ...(typeof Reflect.get(value, "stage") === "string"
      ? [Reflect.get(value, "stage") as string]
      : []),
    ...Object.values(value).flatMap(stages),
  ];
};

describe("MongoDB native Insights event pages", () => {
  const container = `hot-updater-insights-mongo-${randomUUID().slice(0, 8)}`;
  let client: MongoClient;
  let events: Collection<BundleEventRow>;
  let queries: ReturnType<typeof createMongoInsightsQueries>;
  let commands: Document[] = [];
  let getMoreRequests = 0;
  const requests = new Map<number, Document>();
  const returnedRows = new Map<Document, number>();

  beforeAll(async () => {
    // The fixture has no persistent volume and never pulls an image implicitly.
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
    client = new MongoClient(`mongodb://127.0.0.1:${port}/insights_native`, {
      monitorCommands: true,
      serverSelectionTimeoutMS: 30_000,
    });
    await client.connect();
    await client.db().command({ ping: 1 });
    // Exact identity and UUID ordering must not inherit locale/numeric rules.
    events = await client
      .db()
      .createCollection<BundleEventRow>("bundle_events", {
        collation: { locale: "en", strength: 2, numericOrdering: true },
      });
    await events.createIndexes(
      mongoInsightsEventIndexes.map((index) => ({
        ...index,
        collation: { locale: "simple" },
      })),
    );
    for (let offset = 0; offset < 50_104; offset += 400) {
      const rows: BundleEventRow[] = [];
      for (
        let index = offset;
        index < Math.min(offset + 400, 50_104);
        index++
      ) {
        rows.push(index < 50_001 ? activity(index) : movement(index - 50_001));
      }
      await events.insertMany(rows);
    }
    // Only the fixture certifies its own rows. Production wiring needs the
    // durable old-data audit and writer guards; index existence is insufficient.
    queries = createMongoInsightsQueries(events, async () => undefined);
    client.on("commandStarted", (event) => {
      if (
        event.commandName === "getMore" &&
        event.command.collection === events.collectionName
      ) {
        getMoreRequests++;
      }
      if (
        event.commandName === "find" &&
        event.command.find === events.collectionName
      ) {
        commands.push(event.command);
        requests.set(event.requestId, event.command);
      }
    });
    client.on("commandSucceeded", (event) => {
      const command = requests.get(event.requestId);
      if (command) {
        const reply = event.reply as { cursor: { firstBatch: unknown[] } };
        returnedRows.set(command, reply.cursor.firstBatch.length);
        requests.delete(event.requestId);
      }
    });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    spawnSync("docker", ["rm", "--force", container]);
  });

  const readBudget = (maximumReads: number, maximumDocuments: number) => {
    const reads = commands;
    commands = [];
    expect(getMoreRequests).toBe(0);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThanOrEqual(maximumReads);
    let returned = 0;
    for (const command of reads) {
      expect(command.skip ?? 0).toBe(0);
      expect(command.filter).not.toHaveProperty("$expr");
      expect(command.limit).toBeGreaterThan(0);
      expect(command.limit).toBeLessThanOrEqual(101);
      expect(command.collation).toEqual({ locale: "simple" });
      const count = returnedRows.get(command);
      expect(count).toBeDefined();
      expect(count).toBeLessThanOrEqual(command.limit);
      returned += count!;
      returnedRows.delete(command);
    }
    expect(returned).toBeLessThanOrEqual(maximumDocuments);
    return reads;
  };

  const explainReads = async (
    maximumReads: number,
    maximumDocuments: number,
  ) => {
    const reads = readBudget(maximumReads, maximumDocuments);
    let examined = 0;
    for (const command of reads) {
      const plan = await client.db().command({
        explain: {
          find: events.collectionName,
          filter: command.filter,
          sort: command.sort,
          projection: command.projection,
          hint: command.hint,
          collation: command.collation,
          limit: command.limit,
        },
        verbosity: "executionStats",
      });
      const execution = plan.executionStats;
      expect(stages(execution.executionStages)).toContain("IXSCAN");
      expect(stages(execution.executionStages)).not.toContain("COLLSCAN");
      expect(stages(execution.executionStages)).not.toContain("SORT");
      expect(execution.totalDocsExamined).toBeLessThanOrEqual(command.limit);
      // The bounded interval may inspect one terminating index key.
      expect(execution.totalKeysExamined).toBeLessThanOrEqual(
        command.limit + 1,
      );
      examined += execution.totalDocsExamined;
    }
    expect(examined).toBeLessThanOrEqual(maximumDocuments);
  };

  it("preserves every equal-time row across lookahead and fetches no older window rows", async () => {
    commands = [];
    const input = {
      scope: { kind: "all" },
      sinceReceivedAtMs: 60_000,
      beforeReceivedAtMs: 60_001,
      limit: 100,
    } as const;
    const first = await queries.pageEvents(input);
    expect(first.rows.map(({ id }) => id)).toEqual(
      Array.from({ length: 100 }, (_, index) => movement(102 - index).id),
    );
    await explainReads(1, 101);
    const second = await queries.pageEvents({
      ...input,
      cursor: first.nextCursor!,
    });
    expect(second.rows.map(({ id }) => id)).toEqual([
      movement(2).id,
      movement(1).id,
      movement(0).id,
    ]);
    expect(second.nextCursor).toBeNull();
    await explainReads(2, 3);
    await expect(
      queries.pageEvents({
        ...input,
        sinceReceivedAtMs: 59_999,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(commands).toHaveLength(0);
  });

  it.each([
    { kind: "installation", installId },
    { kind: "bundle", bundleId },
  ] as const)(
    "exhausts %j without scanning 50,001 non-movement events",
    async (scope) => {
      commands = [];
      const input = { scope, beforeReceivedAtMs: 100_000, limit: 100 };
      const first = await queries.pageEvents(input);
      expect(first.rows).toHaveLength(100);
      await explainReads(2, 202);
      const last = await queries.pageEvents({
        ...input,
        cursor: first.nextCursor!,
      });
      expect(last.rows.map(({ id }) => id)).toEqual([
        movement(2).id,
        movement(1).id,
        movement(0).id,
      ]);
      expect(last.nextCursor).toBeNull();
      await explainReads(4, 3);
    },
  );

  it("seeks a deep global cursor directly and includes both activity event types", async () => {
    commands = [];
    const input: InsightsEventPageInput = {
      scope: { kind: "all" },
      beforeReceivedAtMs: 100_000,
      limit: 2,
    };
    const page = await queries.pageEvents({
      ...input,
      cursor: createInsightsEventPageCursor(input, {
        receivedAtMs: 3,
        id: activity(3).id,
      }),
    });
    expect(page.rows).toEqual([activity(2), activity(1)]);
    expect(page.rows.map(({ type }) => type)).toEqual([
      "UNCHANGED",
      "RELEASE_ADOPTED",
    ]);
    expect(page.nextCursor).not.toBeNull();
    await explainReads(2, 3);
    const last = await queries.pageEvents({
      ...input,
      cursor: page.nextCursor!,
    });
    expect(last.rows).toEqual([activity(0)]);
    expect(last.nextCursor).toBeNull();
    await explainReads(2, 1);
  });

  it.each([
    ["short", "Case-sensitive-한😀"],
    ["long", `Case-sensitive-${"한😀".repeat(200)}`],
  ] as const)(
    "uses asymmetric bundle directions and exact %s Unicode identities despite collection collation",
    async (size, exact) => {
      const other = "other-bundle";
      const fixture = [
        { from: other, to: exact, type: "UPDATE_APPLIED", install: exact },
        { from: exact, to: other, type: "RECOVERED", install: exact },
        { from: exact, to: other, type: "UPDATE_APPLIED", install: "other" },
        { from: other, to: exact, type: "RECOVERED", install: "other" },
        {
          from: other,
          to: exact.toLowerCase(),
          type: "UPDATE_APPLIED",
          install: exact.toLowerCase(),
        },
      ] as const;
      const rows = fixture.map(
        (item, index): BundleEventRow => ({
          ...createBundleEventRowFixture(String(300_000 + index), 70_000),
          from_bundle_id: item.from,
          to_bundle_id: item.to,
          type: item.type,
          install_id: item.install,
          update_strategy: "appVersion",
        }),
      );
      await events.insertMany(rows);
      try {
        for (const scope of [
          { kind: "bundle", bundleId: exact },
          { kind: "installation", installId: exact },
        ] as const) {
          commands = [];
          const input = { scope, beforeReceivedAtMs: 70_001, limit: 1 };
          const first = await queries.pageEvents(input);
          expect(first.rows.map(({ id }) => id)).toEqual([rows[1]!.id]);
          // Mongo 7 truncates long UTF-8 indexBounds inside explain diagnostics,
          // producing invalid BSON strings. Keep native reads strict; equivalent
          // short identities prove the physical plan and long ones prove the
          // actual query/result budgets and exact identity round trip.
          if (size === "short") await explainReads(2, 4);
          else readBudget(2, 4);
          const last = await queries.pageEvents({
            ...input,
            cursor: first.nextCursor!,
          });
          expect(last.rows.map(({ id }) => id)).toEqual([rows[0]!.id]);
          expect(last.nextCursor).toBeNull();
          if (size === "short") await explainReads(4, 4);
          else readBudget(4, 4);
        }
      } finally {
        await events.deleteMany({ id: { $in: rows.map(({ id }) => id) } });
      }
    },
  );

  it("projects public event fields without modifying raw source metadata or extensions", async () => {
    const row = createBundleEventRowFixture("400000", 65_000);
    const document = {
      ...row,
      _insights_sequence: 17,
      arbitrary_extension: { keep: true },
    };
    await events.insertOne(document);
    try {
      commands = [];
      const page = await queries.pageEvents({
        scope: { kind: "all" },
        sinceReceivedAtMs: 65_000,
        beforeReceivedAtMs: 65_001,
        limit: 1,
      });
      expect(page.rows).toEqual([row]);
      const stored = await events.findOne({ id: row.id });
      expect(stored).toMatchObject(document);
      expect(stored).toHaveProperty("_id");
    } finally {
      await events.deleteOne({ id: row.id });
    }
  });

  it("fails readiness after an index is replaced by a same-name locale index", async () => {
    const index = mongoInsightsEventIndexes[1];
    await events.dropIndex(index.name);
    await events.createIndex(index.key, { name: index.name });
    commands = [];
    try {
      await expect(
        queries.pageEvents({
          scope: { kind: "all" },
          beforeReceivedAtMs: 100_000,
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
      expect(commands).toHaveLength(0);
    } finally {
      await events.dropIndex(index.name);
      await events.createIndex(index.key, {
        name: index.name,
        collation: { locale: "simple" },
      });
    }
  });
});
