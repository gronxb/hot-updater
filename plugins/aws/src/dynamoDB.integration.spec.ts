import {
  DeleteCommand,
  ScanCommand,
  GetCommand,
  PutCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  type BundleEventRow,
  createDatabaseClient,
} from "@hot-updater/plugin-core";
import { setupDatabasePluginTestSuite } from "@hot-updater/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDynamoDBInsightsTable,
  DYNAMODB_INSIGHTS_EVENT_IDS_PARTITION,
  DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
} from "./dynamoDB";
import { DynamoDBIntegrationFixture } from "./dynamoDB.integration-fixture";

const fixture = new DynamoDBIntegrationFixture();
const createPlugin = () => fixture.createPlugin();
const clearTable = () => fixture.reset();

const insightsEvent = (
  index: number,
  input: {
    readonly installId: string;
    readonly receivedAtMs: number;
    readonly type?: BundleEventRow["type"];
    readonly userId?: string | null;
  },
): BundleEventRow => {
  const type = input.type ?? "UPDATE_APPLIED";
  const base = {
    id: `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    type,
    install_id: input.installId,
    user_id: input.userId ?? null,
    metadata: {
      username: null,
      cohort: "0",
      fingerprint_hash: null,
      sdk_version: null,
    },
    from_release_id: null,
    to_release_id: null,
    to_bundle_id: "00000000-0000-0000-0000-000000000002",
    platform: "ios" as const,
    app_version: "1.0.0",
    channel: "production",

    received_at_ms: input.receivedAtMs,
  };
  return type === "UNCHANGED"
    ? {
        ...base,
        type,
        from_bundle_id: null,
        metadata: { ...base.metadata, update_strategy: null },
      }
    : {
        ...base,
        type,
        from_bundle_id: "00000000-0000-0000-0000-000000000001",
        metadata: { ...base.metadata, update_strategy: "appVersion" },
      };
};

beforeAll(() => fixture.start(), 120_000);
afterAll(() => fixture.stop());

setupDatabasePluginTestSuite({
  name: "DynamoDB fixed-model database plugin",
  createPlugin,
  migrate: () => undefined,
  reset: clearTable,
  dispose: () => undefined,
});

describe("DynamoDB aggregate mutations", () => {
  beforeEach(clearTable);

  it("atomically inserts and replaces bundle patches", async () => {
    const database = createDatabaseClient(createPlugin());
    const baseBundle = {
      id: "00000000-0000-0000-0000-000000000901",
      platform: "ios",
      fileHash: "base-hash",
      gitCommitHash: null,
      storageUri: "storage://base.zip",
      archiveByteSize: 3_000_000_001,
      metadata: {},
    } as const;
    const bundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000902",
      fileHash: "bundle-hash",
      patches: [
        {
          baseBundleId: baseBundle.id,
          baseFileHash: baseBundle.fileHash,
          patchFileHash: "first-patch-hash",
          patchStorageUri: "storage://first.patch",
          byteSize: 3_000_000_002,
        },
      ],
    };
    await database.insertBundle(baseBundle);

    await database.insertBundle(bundle);
    await database.updateBundleById(bundle.id, {
      patches: [
        {
          baseBundleId: baseBundle.id,
          baseFileHash: baseBundle.fileHash,
          patchFileHash: "replacement-patch-hash",
          patchStorageUri: "storage://replacement.patch",
          byteSize: 3_000_000_003,
        },
      ],
    });

    await expect(database.getBundleById(bundle.id)).resolves.toMatchObject({
      patches: [
        {
          baseBundleId: baseBundle.id,
          patchFileHash: "replacement-patch-hash",
        },
      ],
    });
  });
});

describe("DynamoDB Insights", () => {
  beforeEach(clearTable);

  it("rebuilds lost latest and user items from a frozen event export", async () => {
    const insights = createDynamoDBInsightsTable({
      client: fixture.client,
      tableName: fixture.tableName,
    });
    const old = insightsEvent(9701, {
      installId: "replay",
      receivedAtMs: 100,
      userId: "old-user",
    });
    const latest = insightsEvent(9702, {
      installId: "replay",
      receivedAtMs: 200,
      userId: "new-user",
    });
    await insights.record({ event: latest });
    await insights.record({ event: old });
    const preserved = { pk: "unrelated", sk: "artifact", value: "preserve" };
    await fixture.client.send(
      new PutCommand({ TableName: fixture.tableName, Item: preserved }),
    );
    const exported = await insights.listEvents({
      filter: { kind: "all" },
      beforeReceivedAtMs: 201,
      limit: 10,
    });
    await fixture.client.send(
      new DeleteCommand({
        TableName: fixture.tableName,
        Key: {
          pk: DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
          sk: old.install_id,
        },
      }),
    );
    await insights.record({ event: latest });
    await expect(
      insights.findLatestEvents({ installId: old.install_id }),
    ).resolves.toEqual([]);
    // This disposable fixture has no concurrent writers and fewer than one
    // native scan page. Production replays into a separately initialized target.
    const snapshot = await fixture.client.send(
      new ScanCommand({ TableName: fixture.tableName, ConsistentRead: true }),
    );
    expect(snapshot.LastEvaluatedKey).toBeUndefined();
    for (const item of snapshot.Items ?? []) {
      if (
        item.pk === "bundle_events" ||
        String(item.pk).startsWith("_hot-updater#insights-")
      ) {
        await fixture.client.send(
          new DeleteCommand({
            TableName: fixture.tableName,
            Key: { pk: item.pk, sk: item.sk },
          }),
        );
      }
    }
    for (const event of [...exported, ...exported.toReversed()])
      await insights.record({ event });
    await expect(
      insights.findLatestEvents({ installId: old.install_id }),
    ).resolves.toEqual([latest]);
    await expect(
      insights.findLatestEvents({ userId: "old-user", limit: 10 }),
    ).resolves.toEqual([]);
    await expect(
      insights.findLatestEvents({ userId: "new-user", limit: 10 }),
    ).resolves.toEqual([latest]);
    await expect(
      insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 201,
        limit: 10,
      }),
    ).resolves.toEqual(exported);
    expect(
      (
        await fixture.client.send(
          new GetCommand({
            TableName: fixture.tableName,
            Key: { pk: preserved.pk, sk: preserved.sk },
            ConsistentRead: true,
          }),
        )
      ).Item,
    ).toEqual(preserved);
  });

  it("rolls back both canonical records when a native transaction condition fails", async () => {
    const insights = createDynamoDBInsightsTable({
      client: fixture.client,
      tableName: fixture.tableName,
    });
    const event = insightsEvent(31, { installId: "atomic", receivedAtMs: 100 });
    const input = { event };
    const name = "reject-insights-transaction";
    fixture.client.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === "TransactWriteItemsCommand") {
          const command = args.input as TransactWriteCommandInput;
          command.TransactItems = [
            ...(command.TransactItems ?? []),
            {
              ConditionCheck: {
                TableName: fixture.tableName,
                Key: { pk: "missing", sk: "guard" },
                ConditionExpression: "attribute_exists(pk)",
              },
            },
          ];
        }
        return next(args);
      },
      { name, step: "initialize" },
    );
    try {
      await expect(insights.record(input)).rejects.toMatchObject({
        name: "TransactionCanceledException",
      });
    } finally {
      fixture.client.middlewareStack.remove(name);
    }
    await expect(
      insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 200,
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([]);
    const marker = await fixture.client.send(
      new GetCommand({
        TableName: fixture.tableName,
        Key: { pk: DYNAMODB_INSIGHTS_EVENT_IDS_PARTITION, sk: event.id },
        ConsistentRead: true,
      }),
    );
    expect(marker.Item).toBeUndefined();
    await insights.record(input);
    await expect(
      insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([input.event]);
  });

  it("treats retry after an ambiguous committed write as an event-ID no-op", async () => {
    const insights = createDynamoDBInsightsTable({
      client: fixture.client,
      tableName: fixture.tableName,
    });
    const event = insightsEvent(41, {
      installId: "retry",
      receivedAtMs: 100,
      userId: "original",
    });
    const input = { event };
    const name = "lose-transaction-response";
    fixture.client.middlewareStack.add(
      (next, context) => async (args) => {
        const result = await next(args);
        if (context.commandName === "TransactWriteItemsCommand")
          throw new Error("response lost after commit");
        return result;
      },
      { name, step: "deserialize" },
    );
    try {
      await expect(insights.record(input)).rejects.toThrow(
        "response lost after commit",
      );
    } finally {
      fixture.client.middlewareStack.remove(name);
    }
    await insights.record(input);
    const reused = {
      ...event,
      install_id: "other-install",
      received_at_ms: 500,
      user_id: "changed",
    };
    await insights.record({
      event: reused,
    });
    await expect(
      insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 1_000,
        limit: 10,
      }),
    ).resolves.toEqual([event]);
    await expect(
      insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([input.event]);
    await expect(
      insights.findLatestEvents({ installId: reused.install_id }),
    ).resolves.toEqual([]);
  });

  it("skips stale user entries and fills the requested result prefix", async () => {
    const insights = createPlugin().models.insights;
    const previous = insightsEvent(51, {
      installId: "a",
      receivedAtMs: 100,
      userId: "old",
    });
    const current = insightsEvent(52, {
      installId: "a",
      receivedAtMs: 200,
      userId: "new",
    });
    const valid = insightsEvent(53, {
      installId: "b",
      receivedAtMs: 100,
      userId: "old",
    });
    for (const event of [previous, current, valid])
      await insights.record({
        event,
      });
    await fixture.client.send(
      new PutCommand({
        TableName: fixture.tableName,
        Item: {
          pk: "_hot-updater#insights-user#old",
          sk: "a",
          order_key: `0000000000000100#${previous.id}`,
          version: 1,
          row: previous,
        },
      }),
    );
    await expect(
      insights.findLatestEvents({ userId: "old", limit: 1 }),
    ).resolves.toEqual([valid]);
  });

  it("does not count an installation again when its receipt time advances between native pages", async () => {
    const writer = createPlugin().models.insights;
    const first = insightsEvent(61, { installId: "a", receivedAtMs: 100 });
    const second = insightsEvent(62, { installId: "b", receivedAtMs: 100 });
    for (const event of [first, second])
      await writer.record({
        event,
      });
    const insights = createDynamoDBInsightsTable({
      client: fixture.client,
      tableName: fixture.tableName,
    });
    const name = "one-installation-per-count-page";
    fixture.client.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === "QueryCommand")
          Reflect.set(args.input, "Limit", 1);
        return next(args);
      },
      { name, step: "initialize" },
    );
    const pause = fixture.pauseNextQuery();
    try {
      const count = insights.countLatestEvents({
        platform: "ios",
        channel: "production",
        sinceMs: 0,
      });
      await pause.observed;
      const newer = {
        ...first,
        id: insightsEvent(63, { installId: "a", receivedAtMs: 300 }).id,
        received_at_ms: 300,
      };
      await writer.record({
        event: newer,
      });
      pause.release();
      await expect(count).resolves.toBe(2);
    } finally {
      pause.release();
      pause.remove();
      fixture.client.middlewareStack.remove(name);
    }
  });

  it("queries initial storage and indexes the first report without a separate initialization step", async () => {
    const insights = createPlugin().models.insights;
    const event = insightsEvent(71, {
      installId: "initial",
      receivedAtMs: 100,
    });
    const installation = event;
    const query = {
      filter: {
        platform: "ios" as const,
        channel: "production",
        type: "UPDATE_APPLIED" as const,
        toBundleId: event.to_bundle_id,
      },
      sinceMs: 0,
      beforeReceivedAtMs: 200,
    };
    await expect(insights.countEvents(query)).resolves.toBe(0);
    await insights.record({ event });
    await expect(insights.countEvents(query)).resolves.toBe(1);
    await expect(
      insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([installation]);
    await expect(
      insights.listEvents({
        ...query,
        filter: { kind: "bundle", ...query.filter },
        limit: 10,
      }),
    ).resolves.toEqual([event]);
  });

  it("records and queries an accepted Unicode channel exceeding the native partition-key size", async () => {
    const insights = createPlugin().models.insights;
    const channel = "가".repeat(700);
    const event = {
      ...insightsEvent(91, { installId: "unicode-channel", receivedAtMs: 100 }),
      channel,
    };
    expect(new TextEncoder().encode(channel).byteLength).toBeGreaterThan(2_048);
    await insights.record({
      event,
    });
    const filter = {
      platform: "ios" as const,
      channel,
      type: "UPDATE_APPLIED" as const,
      toBundleId: event.to_bundle_id,
    };
    const range = { sinceMs: 0, beforeReceivedAtMs: 200 };
    await expect(insights.countEvents({ filter, ...range })).resolves.toBe(1);
    await expect(
      insights.listEvents({
        filter: { kind: "bundle", ...filter },
        ...range,
        limit: 10,
      }),
    ).resolves.toEqual([event]);
    await expect(
      insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([event]);
    await expect(
      insights.countEvents({
        filter: { ...filter, channel: `${channel}나` },
        ...range,
      }),
    ).resolves.toBe(0);
  });
});
