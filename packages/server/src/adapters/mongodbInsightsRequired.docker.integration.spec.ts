import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { BundleEventRow } from "@hot-updater/plugin-core";
import { createInsightsReportPageCursor } from "@hot-updater/plugin-core/internal";
import { type CommandStartedEvent, Long, MongoClient, ObjectId } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { findOpenPort } from "../../../test-utils/src/runtimeProcess";
import { createMongoInsightsModelMaintenance } from "../db/mongoInsightsModel";
import { createMongoInsightsSource } from "../db/mongoInsightsSource";
import { stepMongoInsightsSearch } from "./mongodbInsightsInstallations";
import {
  MONGO_INSIGHTS_ALIAS_COLLECTION,
  MONGO_INSIGHTS_INSTALLATION_COLLECTION,
  MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION,
  MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION,
  MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
  MONGO_INSIGHTS_REPORT_COUNT_COLLECTION,
  MONGO_INSIGHTS_REPORT_JOB_COLLECTION,
  MONGO_INSIGHTS_REPORT_ORDER_COLLECTION,
  MONGO_INSIGHTS_SEARCH_JOB_COLLECTION,
  type MongoInsightsAlias,
  type MongoInsightsInstallation,
  type MongoInsightsProjectionEvent,
  type MongoInsightsProjectionState,
  type MongoInsightsReportCount,
  type MongoInsightsReportJob,
  type MongoInsightsReportOrder,
  type MongoInsightsSearchJob,
} from "./mongodbInsightsModelSchema";
import {
  mongoInsightsDigest,
  mongoInsightsInstallationKey,
} from "./mongodbInsightsProjection";
import { createMongoRequiredInsightsModel } from "./mongodbInsightsRequired";

const docker = (args: string[]) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};

const event = (
  suffix: string,
  receivedAtMs: number,
  input: Partial<BundleEventRow>,
): BundleEventRow =>
  ({
    ...createBundleEventRowFixture(suffix, receivedAtMs),
    type: "UPDATE_APPLIED",
    from_bundle_id: "from",
    update_strategy: "appVersion",
    ...input,
  }) as BundleEventRow;

const stages = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(stages);
  if (typeof value !== "object" || value === null) return [];
  return [
    ...(typeof Reflect.get(value, "stage") === "string"
      ? [String(Reflect.get(value, "stage"))]
      : []),
    ...Object.values(value).flatMap(stages),
  ];
};

const utf16OrderKey = (value: string): string =>
  Array.from({ length: value.length }, (_, index) =>
    value.charCodeAt(index).toString(16).padStart(4, "0"),
  ).join("");

describe("MongoDB durable required Insights model", () => {
  const replicaSet = "insightsRequiredRs";
  const container = `hot-updater-mongo-required-${randomUUID().slice(0, 8)}`;
  let client: MongoClient;

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
      "--setParameter",
      "enableTestCommands=1",
      "--quiet",
    ]);
    const directUri = `mongodb://127.0.0.1:${port}/insights_required?directConnection=true`;
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
      { monitorCommands: true, serverSelectionTimeoutMS: 30_000 },
    );
    await client.connect();
  });

  beforeEach(async () => {
    await client.db().dropDatabase();
  });

  afterAll(async () => {
    await client?.close();
    spawnSync("docker", ["rm", "--force", container]);
  });

  const prepare = async () => {
    const source = createMongoInsightsSource(client);
    await source.prepare({ writersDrained: true });
    for (let step = 0; step < 200; step++) {
      try {
        await source.ensureReady();
        break;
      } catch {
        await source.runStep({ maxItems: 200, maxRequests: 1000 });
      }
    }
    await source.ensureReady();
    const maintenance = createMongoInsightsModelMaintenance(client);
    await maintenance.prepare();
    for (let step = 0; step < 200; step++) {
      try {
        await maintenance.ensureReady();
        break;
      } catch {
        await maintenance.runStep({ maxItems: 100, maxRequests: 1000 });
      }
    }
    await maintenance.ensureReady();
    return maintenance;
  };

  it("rejects live, historical, and report cursors before storage I/O", async () => {
    const model = createMongoRequiredInsightsModel(client);
    let requests = 0;
    const countRequest = (): void => {
      requests++;
    };
    client.on("commandStarted", countRequest);
    try {
      await expect(
        model.pageInstallations({
          kind: "installationId",
          installId: "exact-install",
          limit: 1,
          cursor: JSON.stringify([1, "forged", "0".repeat(64)]),
        } as never),
      ).rejects.toMatchObject({ code: "invalid-query" });
      expect(requests).toBe(0);

      await expect(
        model.pageInstallations({
          kind: "contains",
          query: "historical",
          limit: 1,
          cursor: JSON.stringify([
            1,
            JSON.stringify([
              "published",
              "0".repeat(64),
              "01900000-0000-7000-8000-000000000001",
              randomUUID(),
            ]),
            "not-a-key",
          ]),
        }),
      ).rejects.toMatchObject({ code: "invalid-query" });
      expect(requests).toBe(0);

      await expect(
        model.pageInstallations({
          kind: "all",
          limit: 1,
          cursor: JSON.stringify([
            1,
            JSON.stringify(["live", "all", null, "not-a-snapshot-id"]),
            "0".repeat(64),
          ]),
        }),
      ).rejects.toMatchObject({ code: "invalid-query" });
      expect(requests).toBe(0);

      const reportInput = {
        publicationId: "foreign-publication",
        section: "activeSeries" as const,
        limit: 1,
      };
      const cursor = createInsightsReportPageCursor(
        reportInput,
        "1",
        "foreign-database",
      );
      await expect(
        model.pageReport({ ...reportInput, cursor }),
      ).rejects.toMatchObject({ code: "invalid-query" });
      expect(requests).toBe(0);
    } finally {
      client.off("commandStarted", countRequest);
    }
  });

  it("maps an unavailable retained live snapshot to storage-not-ready", async () => {
    await prepare();
    const model = createMongoRequiredInsightsModel(client);
    await model.append(
      event("490001", 100, {
        install_id: "snapshot-a",
        to_bundle_id: "snapshot-bundle",
      }),
    );
    await model.append(
      event("490002", 200, {
        install_id: "snapshot-b",
        to_bundle_id: "snapshot-bundle",
      }),
    );
    const first = await model.pageInstallations({ kind: "all", limit: 1 });
    if (first.state !== "ready" || first.data.nextCursor === null)
      throw new Error("live continuation missing");
    await client
      .db()
      .collection(MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION)
      .deleteMany({});
    expect(
      await model.pageInstallations({
        kind: "all",
        limit: 1,
        cursor: first.data.nextCursor,
      }),
    ).toMatchObject({
      state: "failed",
      error: { code: "storage-not-ready" },
    });
  }, 120_000);

  it("durably rejects ready report manifest corruption", async () => {
    const maintenance = await prepare();
    const model = createMongoRequiredInsightsModel(client);
    let publicationId: string | null = null;
    for (let step = 0; step < 30; step++) {
      const report = await model.getReport({
        query: { kind: "activeOverview", window: "24h" },
      });
      if (report.state === "ready") {
        publicationId = report.data.id;
        break;
      }
      if (report.state !== "preparing") throw new Error("report failed");
      await maintenance.runJobStep(report.job.id, {
        maxItems: 10,
        maxRequests: 64,
      });
    }
    if (publicationId === null) throw new Error("report did not publish");
    const jobs = client
      .db()
      .collection<MongoInsightsReportJob>(MONGO_INSIGHTS_REPORT_JOB_COLLECTION);
    await jobs.updateOne(
      { _id: publicationId },
      { $set: { "orderTotals.0": -1 } },
      { bypassDocumentValidation: true },
    );
    expect(
      await model.getReport({
        query: { kind: "activeOverview", window: "24h" },
      }),
    ).toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    expect(await jobs.findOne({ _id: publicationId })).toMatchObject({
      state: "failed",
    });

    const bundleIds = ["summary-b", "summary-a"];
    publicationId = null;
    for (let step = 0; step < 30; step++) {
      const report = await model.getReport({
        query: { kind: "bundleSummaries", bundleIds, window: "all" },
      });
      if (report.state === "ready") {
        publicationId = report.data.id;
        if (report.data.kind !== "bundleSummaries")
          throw new Error("wrong report kind");
        expect(report.data.summary.map(({ bundleId }) => bundleId)).toEqual([
          "summary-a",
          "summary-b",
        ]);
        break;
      }
      if (report.state !== "preparing") throw new Error("report failed");
      await maintenance.runJobStep(report.job.id, {
        maxItems: 10,
        maxRequests: 64,
      });
    }
    if (publicationId === null) throw new Error("report did not publish");
    await jobs.updateOne(
      { _id: publicationId },
      { $set: { "publication.summary.0.bundleId": "forged" } },
    );
    expect(
      await model.getReport({
        query: { kind: "bundleSummaries", bundleIds, window: "all" },
      }),
    ).toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    expect(await jobs.findOne({ _id: publicationId })).toMatchObject({
      state: "failed",
    });
  }, 120_000);

  it("durably rejects corrupt report-page query and source coherence", async () => {
    const maintenance = await prepare();
    const model = createMongoRequiredInsightsModel(client);
    const jobs = client
      .db()
      .collection<MongoInsightsReportJob>(MONGO_INSIGHTS_REPORT_JOB_COLLECTION);
    let queryPublicationId: string | null = null;
    for (let step = 0; step < 30; step++) {
      const report = await model.getReport({
        query: { kind: "activeOverview", window: "24h" },
      });
      if (report.state === "ready") {
        queryPublicationId = report.data.id;
        break;
      }
      if (report.state !== "preparing") throw new Error("report failed");
      await maintenance.runJobStep(report.job.id, {
        maxItems: 10,
        maxRequests: 64,
      });
    }
    if (queryPublicationId === null) throw new Error("report did not publish");
    await jobs.updateOne(
      { _id: queryPublicationId },
      { $set: { query: { kind: "corrupt" } as never } },
    );
    expect(
      await model.pageReport({
        publicationId: queryPublicationId,
        section: "activeSeries",
        limit: 1,
      }),
    ).toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    expect(await jobs.findOne({ _id: queryPublicationId })).toMatchObject({
      state: "failed",
    });

    let sourcePublicationId: string | null = null;
    for (let step = 0; step < 30; step++) {
      const report = await model.getReport({
        query: { kind: "activeOverview", window: "7d" },
      });
      if (report.state === "ready") {
        sourcePublicationId = report.data.id;
        break;
      }
      if (report.state !== "preparing") throw new Error("report failed");
      await maintenance.runJobStep(report.job.id, {
        maxItems: 10,
        maxRequests: 64,
      });
    }
    if (sourcePublicationId === null) throw new Error("report did not publish");
    await jobs.updateOne(
      { _id: sourcePublicationId },
      { $set: { sourceId: "00000000-0000-7000-8000-000000000099" } },
    );
    expect(
      await model.pageReport({
        publicationId: sourcePublicationId,
        section: "activeSeries",
        limit: 1,
      }),
    ).toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    expect(await jobs.findOne({ _id: sourcePublicationId })).toMatchObject({
      state: "failed",
    });
  }, 120_000);

  it("orders Unicode cohorts and durably rejects manifest holes", async () => {
    const maintenance = await prepare();
    const model = createMongoRequiredInsightsModel(client);
    const expected = [
      { cohort: "A", value: 1 },
      { cohort: "Aa", value: 2 },
      { cohort: "a", value: 3 },
      { cohort: "\u{10000}", value: 2 },
      { cohort: "\uE000", value: 1 },
    ];
    let suffix = 495_000;
    for (const { cohort, value } of expected) {
      for (let index = 0; index < value; index++) {
        suffix++;
        await model.append(
          event(String(suffix), 100 + suffix, {
            install_id: `cohort-install-${suffix}`,
            to_bundle_id: "cohort-target",
            cohort,
          }),
        );
      }
    }
    let publicationId: string | null = null;
    for (let step = 0; step < 100; step++) {
      const report = await model.getReport({
        query: {
          kind: "bundleDetail",
          bundleId: "cohort-target",
          window: "all",
        },
      });
      if (report.state === "ready") {
        publicationId = report.data.id;
        break;
      }
      if (report.state !== "preparing") throw new Error("report failed");
      await maintenance.runJobStep(report.job.id, {
        maxItems: 2,
        maxRequests: 40,
      });
    }
    if (publicationId === null) throw new Error("report did not publish");
    const rows: { readonly cohort: string; readonly value: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await model.pageReport({
        publicationId,
        section: "movementCohorts",
        metric: "installed",
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (page.state !== "ready" || page.data.section !== "movementCohorts")
        throw new Error("cohort page failed");
      rows.push(...page.data.data);
      cursor = page.data.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(rows).toEqual(expected);

    const counts = client
      .db()
      .collection<MongoInsightsReportCount>(
        MONGO_INSIGHTS_REPORT_COUNT_COLLECTION,
      );
    const stored = await counts
      .find({
        jobId: publicationId,
        section: "movementCohorts",
        metric: "installed",
        bucketStartMs: -1,
      })
      .hint("insights_report_count_label_order_idx")
      .sort({ labelCursorKey: 1 })
      .toArray();
    expect(
      stored.map(({ label, labelOrderKey }) => [label, labelOrderKey]),
    ).toEqual(expected.map(({ cohort }) => [cohort, utf16OrderKey(cohort)]));
    const after = stored[1]!;
    const plan = await counts
      .find({
        jobId: publicationId,
        section: "movementCohorts",
        metric: "installed",
        bucketStartMs: -1,
        labelCursorKey: { $gt: after.labelCursorKey },
      })
      .hint("insights_report_count_label_order_idx")
      .sort({ labelCursorKey: 1 })
      .limit(2)
      .explain("executionStats");
    expect(stages(plan)).toContain("IXSCAN");
    expect(stages(plan)).not.toContain("COLLSCAN");
    expect(stages(plan)).not.toContain("SORT");
    expect(
      Reflect.get(Reflect.get(plan, "executionStats"), "totalDocsExamined"),
    ).toBeLessThanOrEqual(2);
    await client
      .db()
      .collection<MongoInsightsReportOrder>(
        MONGO_INSIGHTS_REPORT_ORDER_COLLECTION,
      )
      .deleteOne({
        jobId: publicationId,
        section: "movementCohorts",
        metric: "installed",
        ordinal: Long.fromNumber(2),
      });
    expect(
      await model.pageReport({
        publicationId,
        section: "movementCohorts",
        metric: "installed",
        limit: 5,
      }),
    ).toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    expect(
      await client
        .db()
        .collection<MongoInsightsReportJob>(
          MONGO_INSIGHTS_REPORT_JOB_COLLECTION,
        )
        .findOne({ _id: publicationId }),
    ).toMatchObject({ state: "failed" });
  }, 120_000);

  it("bounds live and event reads across 50,001 post-snapshot rows", async () => {
    await prepare();
    const model = createMongoRequiredInsightsModel(client);
    const firstEvent = event("496001", 200, {
      install_id: "snapshot-install-a",
    });
    const secondEvent = event("496002", 100, {
      install_id: "snapshot-install-b",
    });
    await model.append(firstEvent);
    await model.append(secondEvent);
    const firstPage = await model.pageInstallations({ kind: "all", limit: 1 });
    if (firstPage.state !== "ready" || firstPage.data.nextCursor === null)
      throw new Error("live cursor missing");
    const decoded: unknown = JSON.parse(firstPage.data.nextCursor);
    if (!Array.isArray(decoded) || typeof decoded[2] !== "string")
      throw new Error("live cursor malformed");
    const afterKey = decoded[2];
    const installations = client
      .db()
      .collection<MongoInsightsInstallation>(
        MONGO_INSIGHTS_INSTALLATION_COLLECTION,
      );
    await installations.insertMany(
      Array.from({ length: 50_001 }, (_, index) => ({
        _id: `${afterKey}~${String(index).padStart(5, "0")}`,
        installId: `post-snapshot-${index}`,
        firstProjectionSequence: Long.fromNumber(10_000 + index),
      })),
    );
    await client.db().setProfilingLevel("all");
    const secondPage = await model.pageInstallations({
      kind: "all",
      cursor: firstPage.data.nextCursor,
      limit: 1,
    });
    await client.db().setProfilingLevel("off");
    if (secondPage.state !== "ready") throw new Error("live page failed");
    expect(secondPage.data.data).toHaveLength(1);
    expect(secondPage.data.data[0]!.install_id).toMatch(/^snapshot-install-/);
    const installationProfile = await client
      .db()
      .collection("system.profile")
      .findOne(
        {
          ns: `${client.db().databaseName}.${MONGO_INSIGHTS_INSTALLATION_COLLECTION}`,
          "command.find": MONGO_INSIGHTS_INSTALLATION_COLLECTION,
        },
        { sort: { ts: -1 } },
      );
    expect(installationProfile?.docsExamined).toBeLessThanOrEqual(2);

    const projectionEvents = client
      .db()
      .collection<MongoInsightsProjectionEvent>(
        MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION,
      );
    await client.withSession({ snapshot: true }, async (session) => {
      await client
        .db()
        .collection(MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION)
        .findOne({}, { session });
      await projectionEvents.insertMany(
        Array.from({ length: 50_001 }, (_, index) => ({
          _id: `00000000-0000-7000-8000-${(0xf00000000000 + index)
            .toString(16)
            .padStart(12, "0")}`,
          sourceId: "00000000-0000-7000-8000-eeeeeeeeeeee",
          sourceShard: 0,
          sourceSequence: Long.fromNumber(100_000 + index),
          projectionSequence: Long.fromNumber(100_000 + index),
          latestVersion: false,
          installKey: `post-snapshot-key-${index}`,
          installId: `post-snapshot-install-${index}`,
          event: { received_at_ms: Number.MAX_SAFE_INTEGER } as BundleEventRow,
        })),
      );
      await client.db().setProfilingLevel("all");
      await projectionEvents
        .find({}, { session, singleBatch: true })
        .hint("insights_projection_received_idx")
        .sort({ "event.received_at_ms": -1, _id: -1 })
        .limit(2)
        .batchSize(2)
        .toArray();
      await client.db().setProfilingLevel("off");
    });
    const eventProfile = await client
      .db()
      .collection("system.profile")
      .findOne(
        {
          ns: `${client.db().databaseName}.${MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION}`,
          "command.find": MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION,
        },
        { sort: { ts: -1 } },
      );
    expect(eventProfile?.docsExamined).toBeLessThanOrEqual(2);
    expect(eventProfile?.keysExamined).toBeLessThanOrEqual(2);
  }, 180_000);

  it("bounds a 50,001-alias contains step in the hinted keyset before LIMIT", async () => {
    await prepare();
    const aliases = client
      .db()
      .collection<MongoInsightsAlias>(MONGO_INSIGHTS_ALIAS_COLLECTION);
    for (let offset = 0; offset < 50_001; offset += 1000) {
      const rows = Array.from(
        { length: Math.min(1000, 50_001 - offset) },
        (_, index) => {
          const installId = `scale-install-${offset + index}`;
          const installKey = mongoInsightsInstallationKey(installId);
          const ordinal = offset + index;
          const value = `alias-${ordinal}`;
          return {
            _id: mongoInsightsDigest([1, "install", value, installId]),
            kind: "install" as const,
            value,
            normalized: value,
            installKey,
            installId,
            firstProjectionSequence: Long.ONE,
          };
        },
      );
      await aliases.insertMany(rows);
    }
    const model = createMongoRequiredInsightsModel(client);
    await model.append(
      event("550001", 100, {
        install_id: "target-install",
        user_id: "TargetUser",
        to_bundle_id: "target-bundle",
      }),
    );
    const explanation = await aliases
      .find({ firstProjectionSequence: { $lte: Long.ONE } })
      .hint("insights_alias_scan_idx")
      .sort({ firstProjectionSequence: 1, _id: 1 })
      .limit(100)
      .explain("executionStats");
    expect(stages(explanation.executionStats.executionStages)).toContain(
      "IXSCAN",
    );
    expect(stages(explanation.executionStats.executionStages)).not.toContain(
      "COLLSCAN",
    );
    expect(stages(explanation.executionStats.executionStages)).not.toContain(
      "SORT",
    );
    expect(explanation.executionStats.nReturned).toBe(100);
    expect(explanation.executionStats.totalDocsExamined).toBe(100);

    const exactExplanation = await aliases
      .find({
        kind: "user",
        value: "TargetUser",
        firstProjectionSequence: { $lte: Long.ONE },
      })
      .hint("insights_alias_exact_idx")
      .sort({ firstProjectionSequence: 1, _id: 1 })
      .limit(100)
      .explain("executionStats");
    expect(stages(exactExplanation.executionStats.executionStages)).toContain(
      "IXSCAN",
    );
    expect(
      stages(exactExplanation.executionStats.executionStages),
    ).not.toContain("COLLSCAN");
    expect(
      stages(exactExplanation.executionStats.executionStages),
    ).not.toContain("SORT");
    expect(exactExplanation.executionStats.nReturned).toBe(1);
    expect(exactExplanation.executionStats.totalDocsExamined).toBe(1);

    const exactReserved = await model.pageInstallations({
      kind: "userId",
      userId: "TargetUser",
      limit: 10,
    });
    expect(exactReserved).toMatchObject({ state: "preparing" });
    if (exactReserved.state !== "preparing")
      throw new Error("exact job not reserved");
    expect(
      await stepMongoInsightsSearch(client, exactReserved.job.id, 100),
    ).toBe("published");
    expect(
      await model.pageInstallations({
        kind: "userId",
        userId: "TargetUser",
        limit: 10,
      }),
    ).toMatchObject({ state: "ready", data: { total: { value: 1 } } });

    const reserved = await model.pageInstallations({
      kind: "contains",
      query: "never-matches",
      limit: 10,
    });
    expect(reserved).toMatchObject({ state: "preparing" });
    if (reserved.state !== "preparing") throw new Error("job not reserved");
    expect(
      await model.pageInstallations({
        kind: "userId",
        userId: "PoisonUser",
        publicationId: reserved.job.id,
        limit: 10,
      }),
    ).toEqual({ state: "expired", publicationId: reserved.job.id });
    await aliases.insertOne({
      _id: mongoInsightsDigest([1, "install", "future", "future-install"]),
      kind: "install",
      value: "future",
      normalized: "future",
      installKey: mongoInsightsInstallationKey("future-install"),
      installId: "future-install",
      firstProjectionSequence: Long.fromNumber(2),
    });
    expect(await stepMongoInsightsSearch(client, reserved.job.id, 100)).toBe(
      "progress",
    );
    expect(
      await client
        .db()
        .collection<MongoInsightsSearchJob>(
          MONGO_INSIGHTS_SEARCH_JOB_COLLECTION,
        )
        .findOne({ _id: reserved.job.id }, { promoteLongs: false }),
    ).toMatchObject({
      state: "preparing",
      total: 0,
      afterAliasSequence: Long.ONE,
    });
  }, 120_000);

  it("publishes 100 bundle summaries within each production request budget", async () => {
    const maintenance = await prepare();
    const model = createMongoRequiredInsightsModel(client);
    const bundleIds = Array.from(
      { length: 100 },
      (_, index) => `bundle-${String(index).padStart(3, "0")}`,
    );
    const jobs = client
      .db()
      .collection<MongoInsightsReportJob>(MONGO_INSIGHTS_REPORT_JOB_COLLECTION);
    let active = false;
    let requests = 0;
    const countRequest = ({ commandName }: CommandStartedEvent): void => {
      if (
        active &&
        !["abortTransaction", "commitTransaction", "endSessions"].includes(
          commandName,
        )
      )
        requests++;
    };
    client.on("commandStarted", countRequest);
    try {
      for (let step = 0; step < 120; step++) {
        const report = await model.getReport({
          query: { kind: "bundleSummaries", bundleIds, window: "all" },
        });
        if (report.state === "ready") {
          if (report.data.kind !== "bundleSummaries")
            throw new Error("wrong report kind");
          expect(report.data.summary).toHaveLength(bundleIds.length);
          expect(
            report.data.summary.every(
              ({ installed, recovered }) => installed === 0 && recovered === 0,
            ),
          ).toBe(true);
          return;
        }
        if (report.state !== "preparing") throw new Error("report failed");
        const before = await jobs.findOne(
          { _id: report.job.id },
          { promoteLongs: false },
        );
        if (!before) throw new Error("report job missing");
        requests = 0;
        active = true;
        const outcome = await maintenance.runJobStep(report.job.id, {
          maxItems: 100,
          maxRequests: 16,
        });
        active = false;
        expect(requests).toBeLessThanOrEqual(16);
        expect(outcome.usage.requests).toBe(requests);
        const after = await jobs.findOne(
          { _id: report.job.id },
          { promoteLongs: false },
        );
        if (!after) throw new Error("report job missing");
        expect(after.publishIndex - before.publishIndex).toBeLessThanOrEqual(5);
      }
    } finally {
      active = false;
      client.off("commandStarted", countRequest);
    }
    throw new Error("bundle summary report did not publish");
  }, 120_000);

  it("fences expired search and report lease holders before takeover", async () => {
    const maintenance = await prepare();
    const model = createMongoRequiredInsightsModel(client);
    await model.append(
      event("590001", 100, {
        install_id: "lease-install",
        user_id: "lease-user",
        to_bundle_id: "lease-bundle",
      }),
    );
    const search = await model.pageInstallations({
      kind: "contains",
      query: "lease-user",
      limit: 10,
    });
    if (search.state !== "preparing") throw new Error("search not reserved");
    const searchJobs = client
      .db()
      .collection<MongoInsightsSearchJob>(MONGO_INSIGHTS_SEARCH_JOB_COLLECTION);
    await searchJobs.updateOne(
      { _id: search.job.id },
      {
        $set: {
          leaseOwner: "crashed-search",
          leaseEpoch: 7,
          leaseExpiresAt: new Date(0),
        },
      },
    );
    expect(
      (
        await searchJobs.updateOne(
          {
            _id: search.job.id,
            leaseOwner: "crashed-search",
            leaseEpoch: 7,
            $expr: { $gt: ["$leaseExpiresAt", "$$NOW"] },
          },
          { $set: { total: 999 } },
        )
      ).matchedCount,
    ).toBe(0);
    await stepMongoInsightsSearch(client, search.job.id, 100);
    expect(
      await searchJobs.findOne({ _id: search.job.id }, { promoteLongs: false }),
    ).toMatchObject({ leaseEpoch: 8, leaseOwner: null, total: 1 });

    const report = await model.getReport({
      query: {
        kind: "bundleSummaries",
        bundleIds: ["lease-bundle"],
        window: "all",
      },
    });
    if (report.state !== "preparing") throw new Error("report not reserved");
    const reportJobs = client
      .db()
      .collection<MongoInsightsReportJob>(MONGO_INSIGHTS_REPORT_JOB_COLLECTION);
    await reportJobs.updateOne(
      { _id: report.job.id },
      {
        $set: {
          leaseOwner: "crashed-report",
          leaseEpoch: 3,
          leaseExpiresAt: new Date(0),
        },
      },
    );
    expect(
      (
        await reportJobs.updateOne(
          {
            _id: report.job.id,
            leaseOwner: "crashed-report",
            leaseEpoch: 3,
            $expr: { $gt: ["$leaseExpiresAt", "$$NOW"] },
          },
          { $set: { publishIndex: 999 } },
        )
      ).matchedCount,
    ).toBe(0);
    await maintenance.runJobStep(report.job.id, {
      maxItems: 1,
      maxRequests: 16,
    });
    expect(
      await reportJobs.findOne({ _id: report.job.id }, { promoteLongs: false }),
    ).toMatchObject({ leaseEpoch: 4, leaseOwner: null, publishIndex: 0 });
  }, 120_000);

  it("durably rejects corrupt latest and public event projection envelopes", async () => {
    const maintenance = await prepare();
    const model = createMongoRequiredInsightsModel(client);
    const row = event("595001", 100, {
      install_id: "envelope-install",
      user_id: "envelope-user",
    });
    await model.append(row);
    const search = await model.pageInstallations({
      kind: "userId",
      userId: "envelope-user",
      limit: 10,
    });
    if (search.state !== "preparing") throw new Error("search not reserved");
    const projections = client
      .db()
      .collection<MongoInsightsProjectionEvent>(
        MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION,
      );
    await projections.updateOne(
      { _id: row.id },
      { $set: { installId: "wrong-install" } },
    );
    expect(
      await maintenance.runJobStep(search.job.id, {
        maxItems: 10,
        maxRequests: 64,
      }),
    ).toMatchObject({ state: "failed", jobId: search.job.id });
    expect(
      await model.pageInstallations({
        kind: "userId",
        userId: "envelope-user",
        limit: 10,
      }),
    ).toMatchObject({
      state: "failed",
      error: { code: "migration-poison", jobId: search.job.id },
    });

    await projections.updateOne(
      { _id: row.id },
      {
        $set: {
          installId: row.install_id,
          installKey: "0".repeat(64),
        },
      },
    );
    expect(
      await model.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 1_000,
        limit: 10,
      }),
    ).toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    expect(
      await client
        .db()
        .collection<MongoInsightsProjectionState>(
          MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
        )
        .findOne({ _id: "projection" }),
    ).toMatchObject({ phase: "failed" });
  }, 120_000);

  it("keeps failed semantic jobs addressable and rolls back digest collisions", async () => {
    const maintenance = await prepare();
    const model = createMongoRequiredInsightsModel(client);
    const row = event("600001", 100, {
      install_id: "valid-install",
      user_id: "valid-user",
      username: "Valid",
      to_bundle_id: "bundle",
    });
    await model.append(row);
    await client
      .db()
      .collection<MongoInsightsAlias>(MONGO_INSIGHTS_ALIAS_COLLECTION)
      .insertOne({
        _id: mongoInsightsDigest(["poison-alias"]),
        kind: "user",
        value: "PoisonUser",
        normalized: "poisonuser",
        installKey: mongoInsightsInstallationKey("expected-install"),
        installId: "different-install",
        firstProjectionSequence: Long.ONE,
      });
    const reserved = await model.pageInstallations({
      kind: "userId",
      userId: "PoisonUser",
      limit: 10,
    });
    expect(reserved).toMatchObject({ state: "preparing" });
    if (reserved.state !== "preparing") throw new Error("job not reserved");
    expect(
      await maintenance.runStep({ maxItems: 100, maxRequests: 1000 }),
    ).toMatchObject({ state: "failed", jobId: reserved.job.id });
    expect(
      await model.pageInstallations({
        kind: "userId",
        userId: "PoisonUser",
        limit: 10,
      }),
    ).toMatchObject({
      state: "failed",
      error: { code: "migration-poison", jobId: reserved.job.id },
    });

    const collisionId = "digest-collision";
    const collisionKey = mongoInsightsInstallationKey(collisionId);
    await client
      .db()
      .collection<MongoInsightsInstallation>(
        MONGO_INSIGHTS_INSTALLATION_COLLECTION,
      )
      .insertOne({
        _id: collisionKey,
        installId: "different-install",
        firstProjectionSequence: Long.ONE,
      });
    const before = await client
      .db()
      .collection("bundle_events")
      .countDocuments();
    await expect(
      model.append(
        event("600002", 200, {
          install_id: collisionId,
          to_bundle_id: "bundle",
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-result" });
    expect(await client.db().collection("bundle_events").countDocuments()).toBe(
      before,
    );

    await client.db().command({
      collMod: MONGO_INSIGHTS_ALIAS_COLLECTION,
      index: { name: "insights_alias_scan_idx", hidden: true },
    });
    await expect(maintenance.ensureReady()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    const aliases = client
      .db()
      .collection<MongoInsightsAlias>(MONGO_INSIGHTS_ALIAS_COLLECTION);
    await aliases.dropIndex("insights_alias_scan_idx");
    await aliases.createIndex(
      { firstProjectionSequence: 1, _id: 1 },
      { name: "insights_alias_scan_idx", unique: true },
    );
    await expect(maintenance.ensureReady()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    await aliases.dropIndex("insights_alias_scan_idx");
    await aliases.createIndex(
      { firstProjectionSequence: 1, _id: 1 },
      { name: "insights_alias_scan_idx" },
    );
    await aliases.createIndex(
      { _id: 1, installKey: 1 },
      { name: "unexpected_unique", unique: true },
    );
    await expect(maintenance.ensureReady()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    await aliases.dropIndex("unexpected_unique");
    const snapshots = client
      .db()
      .collection(MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION);
    const snapshotMetadata = await client
      .db()
      .listCollections(
        { name: MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION },
        { nameOnly: false },
      )
      .next();
    if (!snapshotMetadata) throw new Error("snapshot collection missing");
    await snapshots.drop();
    await client
      .db()
      .createCollection(MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION, {
        collation: { locale: "simple" },
        validator: snapshotMetadata.options?.validator,
        validationLevel: "strict",
        validationAction: "error",
      });
    await expect(maintenance.ensureReady()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
  }, 120_000);

  it("includes appends committed while populated projection backfill is building", async () => {
    const legacy = event("700001", 100, {
      install_id: "legacy-install",
      to_bundle_id: "legacy-bundle",
    });
    await client
      .db()
      .collection("bundle_events")
      .insertOne({ ...legacy, _id: new ObjectId() });
    const source = createMongoInsightsSource(client);
    await source.prepare({ writersDrained: true });
    for (let step = 0; step < 100; step++) {
      try {
        await source.ensureReady();
        break;
      } catch {
        await source.runStep({ maxItems: 100, maxRequests: 1000 });
      }
    }
    await source.ensureReady();
    const maintenance = createMongoInsightsModelMaintenance(client);
    expect(await maintenance.prepare()).toMatchObject({ state: "building" });
    await client.db("admin").command({
      configureFailPoint: "failCommand",
      mode: { times: 2 },
      data: { failCommands: ["find"], errorCode: 91 },
    });
    await expect(
      maintenance.runStep({ maxItems: 100, maxRequests: 1000 }),
    ).rejects.toMatchObject({ code: 91 });
    expect(
      await client
        .db()
        .collection<MongoInsightsProjectionState>(
          MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
        )
        .findOne({ _id: "projection" }),
    ).toMatchObject({ phase: "building", poisonEventId: null });
    const appended = event("700002", 200, {
      install_id: "concurrent-install",
      to_bundle_id: "concurrent-bundle",
    });
    const model = createMongoRequiredInsightsModel(client);
    await model.append(appended);
    for (let step = 0; step < 100; step++) {
      try {
        await maintenance.ensureReady();
        break;
      } catch {
        await maintenance.runStep({ maxItems: 100, maxRequests: 1000 });
      }
    }
    await maintenance.ensureReady();
    const page = await model.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 1000,
      limit: 10,
    });
    expect(page).toMatchObject({ state: "ready" });
    if (page.state !== "ready") throw new Error("event page not ready");
    expect(new Set(page.data.data.map(({ id }) => id))).toEqual(
      new Set([legacy.id, appended.id]),
    );
  }, 120_000);

  it("persists the exact projection poison event without changing its raw row", async () => {
    const poison = event("800001", 100, {
      install_id: "poison-install",
      to_bundle_id: "poison-bundle",
    });
    const raw = { ...poison, _id: new ObjectId() };
    await client.db().collection("bundle_events").insertOne(raw);
    const source = createMongoInsightsSource(client);
    await source.prepare({ writersDrained: true });
    for (let step = 0; step < 100; step++) {
      try {
        await source.ensureReady();
        break;
      } catch {
        await source.runStep({ maxItems: 100, maxRequests: 1000 });
      }
    }
    await source.ensureReady();
    const maintenance = createMongoInsightsModelMaintenance(client);
    await maintenance.prepare();
    await client
      .db()
      .collection<MongoInsightsInstallation>(
        MONGO_INSIGHTS_INSTALLATION_COLLECTION,
      )
      .insertOne({
        _id: mongoInsightsInstallationKey(poison.install_id),
        installId: "digest-collision",
        firstProjectionSequence: Long.ONE,
      });
    let failed = false;
    for (let step = 0; step < 20; step++) {
      try {
        await maintenance.runStep({ maxItems: 100, maxRequests: 1000 });
      } catch {
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    expect(
      await client
        .db()
        .collection<MongoInsightsProjectionState>(
          MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
        )
        .findOne({ _id: "projection" }, { promoteLongs: false }),
    ).toMatchObject({ phase: "failed", poisonEventId: poison.id });
    expect(
      await client.db().collection("bundle_events").findOne({ _id: raw._id }),
    ).toEqual(raw);
  }, 120_000);
});
