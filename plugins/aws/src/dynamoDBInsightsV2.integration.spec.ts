import { createHash } from "node:crypto";

import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BundleEventRow } from "@hot-updater/plugin-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DynamoDBIntegrationFixture } from "./dynamoDB.integration-fixture";
import {
  createDynamoDBInsightsV2,
  DYNAMODB_INSIGHTS_ITEM_MAX_BYTES,
  DYNAMODB_INSIGHTS_TRANSACTION_MAX_ACTIONS,
  DYNAMODB_INSIGHTS_TRANSACTION_MAX_BYTES,
  DYNAMODB_INSIGHTS_LEGACY_PARTITION,
  DYNAMODB_INSIGHTS_V2_PREFIX,
  DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS,
  type DynamoDBInsightsV2Store,
  dynamoDBInsightsMarshalledItemBytes,
  dynamoDBInsightsInstallationHash,
  dynamoDBInsightsTransactionRequestBytes,
  validateDynamoDBInsightsV2Event,
} from "./dynamoDBInsightsV2";
import { createDynamoDBInsightsModel } from "./dynamoDBInsightsV2Jobs";

const fixture = new DynamoDBIntegrationFixture();

let namespaceIndex = 0;
const integrationStore = () => ({
  client: fixture.client,
  tableName: fixture.tableName,
  insightsDatabaseNamespace: `00000000-0000-4000-8000-${(++namespaceIndex)
    .toString()
    .padStart(12, "0")}`,
});

beforeAll(() => fixture.start(), 120_000);
afterAll(() => fixture.stop());

const event = (
  index: number,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    id: `018f0000-0000-7000-8000-${index.toString().padStart(12, "0")}`,
    type: "UPDATE_APPLIED",
    install_id: "installation",
    user_id: "user",
    username: "legacy-user",
    from_release_id: null,
    from_bundle_id: "00000000-0000-0000-0000-000000000001",
    to_release_id: null,
    to_bundle_id: "00000000-0000-0000-0000-000000000002",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "0",
    update_strategy: "appVersion",
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: index,
    ...overrides,
  }) as BundleEventRow;

const order = (row: BundleEventRow) =>
  `${row.received_at_ms.toString().padStart(16, "0")}#${row.id}`;

const sourceShardForId = (id: string): number =>
  Number.parseInt(
    createHash("sha256").update(id).digest("hex").slice(0, 8),
    16,
  ) % DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS;

const writeItems = async (items: readonly Record<string, unknown>[]) => {
  const partitions = new Map<string, Record<string, unknown>[]>();
  for (const item of items) {
    const pk = String(item.pk);
    const partition = partitions.get(pk) ?? [];
    partition.push(item);
    partitions.set(pk, partition);
  }
  const groups = [...partitions.values()];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, groups.length) }, async () => {
      for (;;) {
        const group = groups[next++];
        if (group === undefined) return;
        for (let offset = 0; offset < group.length; offset += 100) {
          const batch = group.slice(offset, offset + 100);
          let lastError: unknown;
          for (let attempt = 0; attempt < 8; attempt++) {
            try {
              await fixture.client.send(
                new TransactWriteCommand({
                  TransactItems: batch.map((Item) => ({
                    Put: { TableName: fixture.tableName, Item },
                  })),
                }),
              );
              lastError = undefined;
              break;
            } catch (error) {
              lastError = error;
              if ((error as { name?: string }).name !== "InternalServerError") {
                throw error;
              }
            }
          }
          if (lastError !== undefined) throw lastError;
        }
      }
    }),
  );
};

type ScaleMetrics = {
  batchGets: number;
  maxBatchKeys: number;
  maxItemBytes: number;
  maxQueryLimit: number;
  maxTransactionActions: number;
  maxTransactionBytes: number;
  queries: number;
  scans: number;
  sourceRowsRead: number;
  transactions: number;
  unmeteredRequests: number;
};

const countingStore = (
  store: DynamoDBInsightsV2Store,
  metrics: ScaleMetrics,
): DynamoDBInsightsV2Store => ({
  ...store,
  client: {
    async send(command) {
      const name = command?.constructor?.name;
      const input = (command as { input?: Record<string, any> }).input ?? {};
      if (
        [
          "BatchGetCommand",
          "GetCommand",
          "PutCommand",
          "QueryCommand",
          "TransactWriteCommand",
        ].includes(String(name)) &&
        input.ReturnConsumedCapacity !== "TOTAL"
      ) {
        metrics.unmeteredRequests += 1;
      }
      if (name === "ScanCommand") metrics.scans += 1;
      if (name === "QueryCommand") {
        metrics.queries += 1;
        if (input.FilterExpression !== undefined) {
          throw new Error("Insights scale query used FilterExpression");
        }
        metrics.maxQueryLimit = Math.max(
          metrics.maxQueryLimit,
          Number(input.Limit ?? 0),
        );
      }
      if (name === "BatchGetCommand") {
        metrics.batchGets += 1;
        const keys = Object.values(input.RequestItems ?? {}).flatMap(
          (request: any) => request.Keys ?? [],
        );
        metrics.maxBatchKeys = Math.max(metrics.maxBatchKeys, keys.length);
      }
      if (name === "TransactWriteCommand") {
        const actions = input.TransactItems ?? [];
        metrics.transactions += 1;
        metrics.maxTransactionActions = Math.max(
          metrics.maxTransactionActions,
          actions.length,
        );
        metrics.maxTransactionBytes = Math.max(
          metrics.maxTransactionBytes,
          dynamoDBInsightsTransactionRequestBytes(actions),
        );
        for (const action of actions) {
          if (action.Put?.Item === undefined) continue;
          metrics.maxItemBytes = Math.max(
            metrics.maxItemBytes,
            dynamoDBInsightsMarshalledItemBytes(action.Put.Item),
          );
        }
      }
      const result = await fixture.client.send(command as never);
      if (
        name === "QueryCommand" &&
        String(input.ExpressionAttributeValues?.[":pk"]).includes("#source#")
      ) {
        const queryResult = result as {
          readonly Count?: number;
          readonly Items?: readonly unknown[];
        };
        metrics.sourceRowsRead +=
          queryResult.Items?.length ?? queryResult.Count ?? 0;
      }
      return result;
    },
  },
});

describe("DynamoDB Insights v2 LocalStack", () => {
  beforeEach(() => fixture.reset());

  it("advances every durable preparation job through the public model", async () => {
    const model = createDynamoDBInsightsModel(integrationStore());
    await model.append(event(1));

    const source = await model.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 2,
      limit: 10,
    });
    expect(source).toMatchObject({ state: "preparing" });
    if (source.state !== "preparing") throw new Error("source already ready");
    await model.runMaintenanceStep({
      jobId: source.job.id,
      maxItems: 256,
      maxRequests: 512,
    });

    const projection = await model.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 2,
      limit: 10,
    });
    expect(projection).toMatchObject({ state: "preparing" });
    if (projection.state !== "preparing") {
      throw new Error("projection already ready");
    }
    await model.runMaintenanceStep({
      jobId: projection.job.id,
      maxItems: 256,
      maxRequests: 512,
    });
    await expect(
      model.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 2,
        limit: 10,
      }),
    ).resolves.toMatchObject({ state: "ready", data: { data: [event(1)] } });

    const report = await model.getReport({
      query: { kind: "installationOverview" },
    });
    expect(report).toMatchObject({ state: "preparing" });
    if (report.state !== "preparing") throw new Error("report already ready");
    await model.runMaintenanceStep({
      jobId: report.job.id,
      maxItems: 256,
      maxRequests: 512,
    });
    await expect(
      model.getReport({ query: { kind: "installationOverview" } }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { summary: { trackedInstallations: 1 } },
    });
  });

  it("replays bounded migration, projects every source shard, and serves native pages", async () => {
    const first = event(1);
    const second = event(2, {
      type: "RECOVERED",
      from_bundle_id: first.to_bundle_id,
    });
    await writeItems(
      [first, second].map((row) => ({
        pk: DYNAMODB_INSIGHTS_LEGACY_PARTITION,
        sk: order(row),
        version: 1,
        row,
      })),
    );
    const insights = createDynamoDBInsightsV2(integrationStore());

    await expect(
      insights.maintenance.migrateLegacy({ maxItems: 1, maxRequests: 14 }),
    ).resolves.toMatchObject({ state: "running", migrated: 1 });
    const activity = event(3, {
      type: "UNCHANGED",
      from_bundle_id: null,
      update_strategy: null,
    });
    await insights.append(activity);
    await expect(
      insights.maintenance.migrateLegacy({ maxItems: 1, maxRequests: 14 }),
    ).resolves.toMatchObject({ state: "done", migrated: 1 });
    await expect(
      insights.maintenance.migrateLegacy({ maxItems: 1, maxRequests: 14 }),
    ).resolves.toEqual({ state: "done", migrated: 0 });

    for (
      let sourceShard = 0;
      sourceShard < DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS;
      sourceShard++
    ) {
      await insights.maintenance.project({
        sourceShard,
        maxItems: 32,
        maxRequests: 65,
      });
    }

    const scanCommands = fixture.trackCommands("ScanCommand");
    const firstPage = await insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 4,
      limit: 2,
    });
    expect(firstPage).toMatchObject({
      state: "ready",
      data: {
        data: [
          { id: activity.id, received_at_ms: 3 },
          { id: second.id, received_at_ms: 2 },
        ],
        hasNext: true,
      },
    });
    if (firstPage.state !== "ready") throw new Error("projection not ready");
    const seen = [...firstPage.data.data];
    let cursor = firstPage.data.nextCursor;
    while (cursor !== null) {
      const page = await insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 4,
        limit: 2,
        cursor,
      });
      if (page.state !== "ready") throw new Error("projection not ready");
      seen.push(...page.data.data);
      cursor = page.data.nextCursor;
    }
    expect(seen.map(({ id }) => id)).toEqual([
      activity.id,
      second.id,
      first.id,
    ]);

    await expect(
      insights.pageEvents({
        selector: { kind: "bundleId", bundleId: first.to_bundle_id },
        beforeReceivedAtMs: 4,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [{ id: second.id }, { id: first.id }] },
    });
    await expect(
      insights.pageInstallations({
        kind: "installationId",
        installId: first.install_id,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [{ id: activity.id }], hasNext: false },
    });
    expect(scanCommands.count()).toBe(0);
    scanCommands.remove();
  }, 120_000);

  it("durably reuses arbitrary legacy-ID poison while v2 append remains available", async () => {
    const poison = { ...event(4), id: "legacy-event-id" } as BundleEventRow;
    await writeItems([
      {
        pk: DYNAMODB_INSIGHTS_LEGACY_PARTITION,
        sk: order(poison),
        version: 1,
        row: poison,
      },
    ]);
    const insights = createDynamoDBInsightsV2(integrationStore());
    const scans = fixture.trackCommands("ScanCommand");

    const failed = await insights.maintenance.migrateLegacy({
      maxItems: 1,
      maxRequests: 14,
    });
    expect(failed).toMatchObject({
      state: "failed",
      poison: { legacyKey: order(poison) },
    });
    await expect(
      insights.maintenance.migrateLegacy({ maxItems: 1, maxRequests: 14 }),
    ).resolves.toEqual(failed);
    await expect(insights.append(event(5))).resolves.toBeUndefined();
    expect(scans.count()).toBe(0);
    scans.remove();
  }, 120_000);

  it("returns typed storage corruption for a wrong live identity digest", async () => {
    const insights = createDynamoDBInsightsV2(integrationStore());
    await insights.maintenance.initialize();
    await Promise.all(
      ["source", "projection#events", "projection#installations"].map((sk) =>
        fixture.client.send(
          new PutCommand({
            TableName: fixture.tableName,
            Item: {
              pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#state`,
              sk,
              item_type: "insights-readiness",
              job_id:
                sk === "source"
                  ? "dynamodb-insights-v2-migration"
                  : "dynamodb-insights-v2-projection",
              state: "ready",
              storage_revision: "dynamodb-i2-v1",
            },
          }),
        ),
      ),
    );
    await fixture.client.send(
      new PutCommand({
        TableName: fixture.tableName,
        Item: {
          pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#latest#0`,
          sk: "0".repeat(64),
          item_type: "installation-identity",
          install_id: "digest-does-not-match",
        },
      }),
    );
    await expect(
      insights.pageInstallations({ kind: "all", limit: 1 }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
  });

  it("uses bounded report keys and types missing section data as corruption", async () => {
    const model = createDynamoDBInsightsModel(integrationStore());
    await expect(
      model.maintenance.migrateLegacy({ maxItems: 1, maxRequests: 14 }),
    ).resolves.toMatchObject({ state: "done" });
    await model.append(
      event(10, {
        install_id: "install-a",
        to_bundle_id: "00000000-0000-0000-0000-00000000000a",
        received_at_ms: Date.now() - 1_000,
      }),
    );
    const scans = fixture.trackCommands("ScanCommand");
    const preparing = await model.getReport({
      query: { kind: "installationOverview" },
    });
    if (preparing.state !== "preparing") {
      throw new Error("expected report preparation");
    }
    for (let step = 0; step < 32; step++) {
      const result = await model.maintenance.runJob({
        jobId: preparing.job.id,
        maxItems: 256,
        maxRequests: 128,
      });
      if (result.state === "failed") throw new Error("report job failed");
      if (result.state === "ready") break;
      if (step === 31) throw new Error("report job did not finish");
    }
    const ready = await model.getReport({
      query: { kind: "installationOverview" },
    });
    if (ready.state !== "ready") throw new Error("expected ready report");
    await expect(
      model.pageReport({
        publicationId: ready.data.id,
        section: "bundleDistribution",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { total: { state: "exact", value: 1 } },
    });
    await fixture.client.send(
      new DeleteCommand({
        TableName: fixture.tableName,
        Key: {
          pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#jobs#${ready.data.id}#sections`,
          sk: '["bundleDistribution",""]',
        },
      }),
    );
    await expect(
      model.pageReport({
        publicationId: ready.data.id,
        section: "bundleDistribution",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    expect(scans.count()).toBe(0);
    scans.remove();
  }, 120_000);

  it("drains a pinned live cutoff through identities appended between pages", async () => {
    const insights = createDynamoDBInsightsV2(integrationStore());
    await insights.maintenance.migrateLegacy({ maxItems: 1, maxRequests: 14 });
    const installs = Array.from(
      { length: 2_000 },
      (_, index) => `live-${index}`,
    )
      .map((installId) => ({
        installId,
        hash: dynamoDBInsightsInstallationHash(installId),
      }))
      .filter(({ hash }) => hash[0] === "0")
      .sort((left, right) => left.hash.localeCompare(right.hash));
    const firstInstall = installs[0]!;
    const lastInstall = installs.at(-1)!;
    const between = installs.slice(1, 22);
    await insights.append(event(100, { install_id: firstInstall.installId }));
    await insights.append(event(101, { install_id: lastInstall.installId }));
    for (
      let sourceShard = 0;
      sourceShard < DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS;
      sourceShard++
    ) {
      await insights.maintenance.project({
        sourceShard,
        maxItems: 32,
        maxRequests: 65,
      });
    }
    const firstPage = await insights.pageInstallations({
      kind: "all",
      limit: 1,
    });
    if (firstPage.state !== "ready") throw new Error("projection not ready");
    expect(firstPage.data.data.map(({ install_id }) => install_id)).toEqual([
      firstInstall.installId,
    ]);
    let eventId = 102;
    for (const install of between) {
      await insights.append(
        event(eventId++, { install_id: install.installId }),
      );
    }

    const seen: string[] = [];
    let cursor = firstPage.data.nextCursor;
    let pages = 0;
    while (cursor !== null) {
      const page = await insights.pageInstallations({
        kind: "all",
        limit: 1,
        cursor,
      });
      if (page.state !== "ready") throw new Error("projection not ready");
      seen.push(...page.data.data.map(({ install_id }) => install_id));
      cursor = page.data.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(between.length + 2);
    }
    expect(seen).toEqual([lastInstall.installId]);
  }, 120_000);

  it("keeps an exact live lookup on its before-read projection cutoff", async () => {
    const store = integrationStore();
    const insights = createDynamoDBInsightsV2(store);
    await insights.maintenance.migrateLegacy({ maxItems: 1, maxRequests: 14 });
    const original = event(200, { install_id: "exact-cutoff" });
    const concurrent = event(201, { install_id: original.install_id });
    await insights.append(original);
    for (
      let sourceShard = 0;
      sourceShard < DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS;
      sourceShard++
    ) {
      await insights.maintenance.project({
        sourceShard,
        maxItems: 32,
        maxRequests: 65,
      });
    }
    let appended = false;
    const racing = createDynamoDBInsightsV2({
      ...store,
      client: {
        async send(command) {
          if (
            !appended &&
            command instanceof GetCommand &&
            String(command.input.Key?.pk).includes("#latest#")
          ) {
            appended = true;
            await insights.append(concurrent);
          }
          return fixture.client.send(command as never);
        },
      },
    });

    await expect(
      racing.pageInstallations({
        kind: "installationId",
        installId: original.install_id,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [{ id: original.id }] },
    });
    await expect(
      insights.pageInstallations({
        kind: "installationId",
        installId: original.install_id,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [{ id: concurrent.id }] },
    });
  }, 120_000);

  it("keeps the event-time maximum for out-of-order events on one source shard", async () => {
    const insights = createDynamoDBInsightsV2(integrationStore());
    await insights.maintenance.migrateLegacy({ maxItems: 1, maxRequests: 14 });
    const byShard = new Map<number, BundleEventRow>();
    let first: BundleEventRow | undefined;
    let second: BundleEventRow | undefined;
    for (let index = 300; second === undefined; index++) {
      const candidate = event(index, { install_id: "out-of-order" });
      const sourceShard = sourceShardForId(candidate.id);
      const existing = byShard.get(sourceShard);
      if (existing === undefined) byShard.set(sourceShard, candidate);
      else {
        first = existing;
        second = candidate;
      }
    }
    const newest = { ...first!, received_at_ms: 10_000 };
    const late = { ...second!, received_at_ms: 9_000 };
    await insights.append(newest);
    await insights.append(late);
    for (
      let sourceShard = 0;
      sourceShard < DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS;
      sourceShard++
    ) {
      await insights.maintenance.project({
        sourceShard,
        maxItems: 32,
        maxRequests: 65,
      });
    }

    await expect(
      insights.pageInstallations({
        kind: "installationId",
        installId: newest.install_id,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [{ id: newest.id }] },
    });
  }, 120_000);

  it("retries concurrent caught-up appends for one installation and source shard", async () => {
    const store = integrationStore();
    const insights = createDynamoDBInsightsV2(store);
    await insights.maintenance.migrateLegacy({ maxItems: 1, maxRequests: 14 });
    const byShard = new Map<number, BundleEventRow>();
    let first: BundleEventRow | undefined;
    let second: BundleEventRow | undefined;
    for (let index = 400; second === undefined; index++) {
      const candidate = event(index, { install_id: "concurrent-prefix" });
      const sourceShard = sourceShardForId(candidate.id);
      const existing = byShard.get(sourceShard);
      if (existing === undefined) byShard.set(sourceShard, candidate);
      else {
        first = existing;
        second = candidate;
      }
    }
    const older = { ...first!, received_at_ms: 20_000 };
    const newer = { ...second!, received_at_ms: 20_001 };
    const sourceShard = sourceShardForId(older.id);
    let appendTransactions = 0;
    const conditionalFailures = new Set<string>();
    let waiting = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing = createDynamoDBInsightsV2({
      ...store,
      client: {
        async send(command) {
          const appendActions =
            command instanceof TransactWriteCommand &&
            command.input.TransactItems?.some(
              (action) => action.Put?.Item?.item_type === "event-id-guard",
            )
              ? command.input.TransactItems
              : undefined;
          if (appendActions !== undefined) {
            appendTransactions += 1;
            if (waiting < 2) {
              waiting += 1;
              if (waiting === 2) release();
              await bothReady;
            }
          }
          try {
            return await fixture.client.send(command as never);
          } catch (error) {
            const reasons =
              typeof error === "object" && error !== null
                ? Reflect.get(error, "CancellationReasons")
                : undefined;
            if (appendActions !== undefined && Array.isArray(reasons)) {
              reasons.forEach((reason, index) => {
                if (
                  typeof reason !== "object" ||
                  reason === null ||
                  Reflect.get(reason, "Code") !== "ConditionalCheckFailed"
                ) {
                  return;
                }
                const action = appendActions[index];
                if (
                  action?.Put?.Item?.item_type ===
                  "installation-current-candidate"
                ) {
                  conditionalFailures.add("installation-current-candidate");
                } else if (action?.Update?.Key?.sk === "!clock") {
                  conditionalFailures.add("source-clock");
                } else if (
                  String(action?.Update?.Key?.sk).startsWith(
                    "projection#source#",
                  )
                ) {
                  conditionalFailures.add("projection-checkpoint");
                }
              });
            }
            throw error;
          }
        },
      },
    });

    await expect(
      Promise.all([racing.append(older), racing.append(newer)]),
    ).resolves.toEqual([undefined, undefined]);
    expect(appendTransactions).toBeGreaterThanOrEqual(3);
    expect(conditionalFailures).toEqual(
      new Set([
        "source-clock",
        "installation-current-candidate",
        "projection-checkpoint",
      ]),
    );
    for (let shard = 0; shard < DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS; shard++) {
      await insights.maintenance.project({
        sourceShard: shard,
        maxItems: 32,
        maxRequests: 65,
      });
    }

    const sourcePage = await fixture.client.send(
      new QueryCommand({
        TableName: fixture.tableName,
        ConsistentRead: true,
        KeyConditionExpression: "#pk = :pk AND #sk > :clock",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": `${DYNAMODB_INSIGHTS_V2_PREFIX}#source#${sourceShard
            .toString()
            .padStart(2, "0")}`,
          ":clock": "!clock",
        },
        Limit: 3,
        ScanIndexForward: true,
      }),
    );
    expect(
      sourcePage.Items?.map((item) => [item.source_sequence, item.event_id]),
    ).toEqual([
      [1, expect.stringMatching(/^018f/)],
      [2, expect.stringMatching(/^018f/)],
    ]);
    expect(new Set(sourcePage.Items?.map((item) => item.event_id))).toEqual(
      new Set([older.id, newer.id]),
    );
    const readiness = await fixture.client.send(
      new BatchGetCommand({
        RequestItems: {
          [fixture.tableName]: {
            ConsistentRead: true,
            Keys: [
              ...[
                "source",
                "projection#events",
                "projection#installations",
              ].map((sk) => ({
                pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#state`,
                sk,
              })),
              {
                pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#source#${sourceShard
                  .toString()
                  .padStart(2, "0")}`,
                sk: "!clock",
              },
              {
                pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#state`,
                sk: `projection#source#${sourceShard
                  .toString()
                  .padStart(2, "0")}`,
              },
            ],
          },
        },
      }),
    );
    expect(readiness.Responses?.[fixture.tableName]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sk: "source", state: "ready" }),
        expect.objectContaining({ sk: "projection#events", state: "ready" }),
        expect.objectContaining({
          sk: "projection#installations",
          state: "ready",
        }),
        expect.objectContaining({
          item_type: "source-clock",
          sequence: 2,
        }),
        expect.objectContaining({
          item_type: "insights-projection-checkpoint",
          sequence: 2,
        }),
      ]),
    );
    expect(
      readiness.Responses?.[fixture.tableName]?.some((item) =>
        Object.hasOwn(item, "poison"),
      ),
    ).toBe(false);
    await expect(
      insights.pageInstallations({
        kind: "installationId",
        installId: older.install_id,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [{ id: newer.id }] },
    });
  }, 120_000);

  it.skipIf(process.env.HOT_UPDATER_AWS_INSIGHTS_FULL_SCALE !== "1")(
    "accepts 50,001 raw events through source, projection, live, search, and report maintenance",
    async () => {
      const rawCount = 50_001;
      let seeded = 0;
      for (let start = 1; start <= rawCount; start += 100) {
        const batch: Record<string, unknown>[] = [];
        for (
          let index = start;
          index < Math.min(start + 100, rawCount + 1);
          index++
        ) {
          const row = event(index, {
            install_id: `scale-install-${index.toString().padStart(5, "0")}`,
            user_id: `scale-user-${index.toString().padStart(5, "0")}`,
            username: `acceptance-scale-${index.toString().padStart(5, "0")}`,
          });
          validateDynamoDBInsightsV2Event(row);
          batch.push({
            pk: DYNAMODB_INSIGHTS_LEGACY_PARTITION,
            sk: order(row),
            version: 1,
            row,
          });
          seeded += 1;
        }
        await writeItems(batch);
      }
      expect(seeded).toBe(rawCount);
      let rawPhysicalCount = 0;
      let rawCursor: Record<string, unknown> | undefined;
      do {
        const page = await fixture.client.send(
          new QueryCommand({
            TableName: fixture.tableName,
            ConsistentRead: true,
            KeyConditionExpression: "#pk = :pk",
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: {
              ":pk": DYNAMODB_INSIGHTS_LEGACY_PARTITION,
            },
            ExclusiveStartKey: rawCursor,
            Limit: 1_000,
            Select: "COUNT",
            ReturnConsumedCapacity: "TOTAL",
          }),
        );
        rawPhysicalCount += page.Count ?? 0;
        rawCursor = page.LastEvaluatedKey;
      } while (rawCursor !== undefined);
      expect(rawPhysicalCount).toBe(rawCount);

      const metrics: ScaleMetrics = {
        batchGets: 0,
        maxBatchKeys: 0,
        maxItemBytes: 0,
        maxQueryLimit: 0,
        maxTransactionActions: 0,
        maxTransactionBytes: 0,
        queries: 0,
        scans: 0,
        sourceRowsRead: 0,
        transactions: 0,
        unmeteredRequests: 0,
      };
      const store = countingStore(integrationStore(), metrics);
      let model = createDynamoDBInsightsModel(store);

      let migrated = 0;
      for (;;) {
        const step = await model.maintenance.migrateLegacy({
          maxItems: 32,
          maxRequests: 64,
        });
        if (step.state === "failed") throw new Error("scale migration failed");
        migrated += step.migrated;
        if (step.state === "done") break;
      }
      expect(migrated).toBe(rawCount);

      let projected = 0;
      for (
        let sourceShard = 0;
        sourceShard < DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS;
        sourceShard++
      ) {
        for (;;) {
          const step = await model.maintenance.project({
            sourceShard,
            maxItems: 32,
            maxRequests: 80,
          });
          projected += step.projected;
          if (step.caughtUp) break;
        }
      }
      expect(projected).toBe(rawCount);

      const search = await model.pageInstallations({
        kind: "contains",
        query: "acceptance-scale",
        limit: 100,
      });
      if (search.state !== "preparing") {
        throw new Error("scale search did not reserve a durable job");
      }
      model = createDynamoDBInsightsModel(store);
      const concurrent = event(rawCount + 1, {
        install_id: `scale-install-${rawCount.toString().padStart(5, "0")}`,
        user_id: `scale-user-${rawCount.toString().padStart(5, "0")}`,
        username: "acceptance-scale-concurrent",
      });
      await Promise.all([
        model.maintenance.runJob({
          jobId: search.job.id,
          maxItems: 32,
          maxRequests: 128,
        }),
        model.append(concurrent),
      ]);
      model = createDynamoDBInsightsModel(store);
      for (let stepIndex = 0; stepIndex < 20_000; stepIndex++) {
        const step = await model.maintenance.runJob({
          jobId: search.job.id,
          maxItems: 96,
          maxRequests: 128,
        });
        if (step.state === "failed") throw new Error("scale search job failed");
        if (step.state === "ready") break;
        if (stepIndex === 19_999) throw new Error("scale search job stalled");
      }

      const stateKeys = Array.from(
        { length: DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS },
        (_, sourceShard) => [
          {
            pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#source#${sourceShard.toString().padStart(2, "0")}`,
            sk: "!clock",
          },
          {
            pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#state`,
            sk: `projection#source#${sourceShard.toString().padStart(2, "0")}`,
          },
        ],
      ).flat();
      const state = await fixture.client.send(
        new BatchGetCommand({
          RequestItems: {
            [fixture.tableName]: { ConsistentRead: true, Keys: stateKeys },
          },
        }),
      );
      const stateItems: Record<string, unknown>[] =
        state.Responses?.[fixture.tableName] ?? [];
      const sourceTotal = stateItems
        .filter((item) => item.item_type === "source-clock")
        .reduce((total, item) => total + Number(item.sequence), 0);
      const projectionTotal = stateItems
        .filter((item) => item.item_type === "insights-projection-checkpoint")
        .reduce((total, item) => total + Number(item.sequence), 0);
      expect(sourceTotal).toBe(rawCount + 1);
      expect(projectionTotal).toBe(rawCount + 1);

      let eventCount = 0;
      let eventCursor: string | undefined;
      do {
        const page = await model.pageEvents({
          selector: { kind: "all" },
          beforeReceivedAtMs: rawCount + 2,
          limit: 100,
          ...(eventCursor === undefined ? {} : { cursor: eventCursor }),
        });
        if (page.state !== "ready") throw new Error("scale events not ready");
        eventCount += page.data.data.length;
        eventCursor = page.data.nextCursor ?? undefined;
      } while (eventCursor !== undefined);
      expect(eventCount).toBe(rawCount + 1);

      let liveCount = 0;
      let liveCursor: string | undefined;
      let concurrentLatest = false;
      do {
        const page = await model.pageInstallations({
          kind: "all",
          limit: 100,
          ...(liveCursor === undefined ? {} : { cursor: liveCursor }),
        });
        if (page.state !== "ready") throw new Error("scale live not ready");
        liveCount += page.data.data.length;
        concurrentLatest ||= page.data.data.some(
          (row) => row.id === concurrent.id,
        );
        liveCursor = page.data.nextCursor ?? undefined;
      } while (liveCursor !== undefined);
      expect(liveCount).toBe(rawCount);
      expect(concurrentLatest).toBe(true);

      const published = await model.pageInstallations({
        kind: "contains",
        query: "acceptance-scale",
        limit: 100,
      });
      if (published.state !== "ready") {
        throw new Error("scale search publication not ready");
      }
      expect(published.data.total).toMatchObject({
        state: "exact",
        value: rawCount,
      });
      let historicalCount = 0;
      let historicalLatest = false;
      let historicalPage = published;
      for (;;) {
        historicalCount += historicalPage.data.data.length;
        historicalLatest ||= historicalPage.data.data.some(
          (row) => row.id === event(rawCount).id,
        );
        if (historicalPage.data.nextCursor === null) break;
        const next = await model.pageInstallations({
          kind: "contains",
          query: "acceptance-scale",
          limit: 100,
          cursor: historicalPage.data.nextCursor,
        });
        if (next.state !== "ready") {
          throw new Error("scale search continuation not ready");
        }
        historicalPage = next;
      }
      expect(historicalCount).toBe(rawCount);
      expect(historicalLatest).toBe(true);

      const sourceReadsBeforeReport = metrics.sourceRowsRead;
      const report = await model.getReport({
        query: { kind: "installationOverview" },
      });
      if (report.state !== "preparing") {
        throw new Error("scale report did not reserve a durable job");
      }
      for (let stepIndex = 0; stepIndex < 20_000; stepIndex++) {
        const step = await model.maintenance.runJob({
          jobId: report.job.id,
          maxItems: 96,
          maxRequests: 128,
        });
        if (step.state === "failed") throw new Error("scale report job failed");
        if (step.state === "ready") break;
        if (stepIndex === 19_999) throw new Error("scale report job stalled");
      }
      const readyReport = await model.getReport({
        query: { kind: "installationOverview" },
      });
      if (readyReport.state !== "ready") {
        throw new Error("scale report publication not ready");
      }
      const reportPage = await model.pageReport({
        publicationId: readyReport.data.id,
        section: "bundleDistribution",
        limit: 100,
      });
      if (reportPage.state !== "ready") {
        throw new Error("scale report page not ready");
      }
      expect(reportPage.data.data.length).toBeGreaterThan(0);
      expect(metrics.sourceRowsRead).toBeGreaterThan(sourceReadsBeforeReport);

      expect(metrics.scans).toBe(0);
      expect(metrics.unmeteredRequests).toBe(0);
      expect(metrics.maxBatchKeys).toBeLessThanOrEqual(100);
      expect(metrics.maxQueryLimit).toBeLessThanOrEqual(101);
      expect(metrics.maxTransactionActions).toBeLessThanOrEqual(
        DYNAMODB_INSIGHTS_TRANSACTION_MAX_ACTIONS,
      );
      expect(metrics.maxTransactionBytes).toBeLessThan(
        DYNAMODB_INSIGHTS_TRANSACTION_MAX_BYTES,
      );
      expect(metrics.maxItemBytes).toBeLessThan(
        DYNAMODB_INSIGHTS_ITEM_MAX_BYTES,
      );
      expect(metrics.transactions).toBeGreaterThan(0);
      expect(metrics.queries).toBeGreaterThan(0);
      expect(metrics.batchGets).toBeGreaterThan(0);
      process.stdout.write(
        `${JSON.stringify({
          acceptance: "dynamodb-insights-v2-full-source-50001",
          rawPhysicalCount,
          sourceTotal,
          projectionTotal,
          eventCount,
          liveCount,
          historicalCount,
          reportRows: reportPage.data.data.length,
          metrics,
        })}\n`,
      );
    },
    3_600_000,
  );
});
