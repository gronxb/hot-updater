import {
  GetCommand,
  PutCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  type BundleEventRow,
  createDatabaseClient,
  toInsightsInstallationRow,
} from "@hot-updater/plugin-core";
import { setupDatabasePluginTestSuite } from "@hot-updater/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDynamoDBInsightsTable,
  DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
  DYNAMODB_INSIGHTS_EVENT_IDS_PARTITION,
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
    username: null,
    from_release_id: null,
    to_release_id: null,
    to_bundle_id: "00000000-0000-0000-0000-000000000002",
    platform: "ios" as const,
    app_version: "1.0.0",
    channel: "production",
    cohort: "0",
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: input.receivedAtMs,
  };
  return type === "UNCHANGED"
    ? { ...base, type, from_bundle_id: null, update_strategy: null }
    : {
        ...base,
        type,
        from_bundle_id: "00000000-0000-0000-0000-000000000001",
        update_strategy: "appVersion",
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

  it("pages events and keeps only the latest installation identity", async () => {
    const insights = createPlugin().models.insights;
    const first = insightsEvent(1, {
      installId: "install-a",
      receivedAtMs: 100,
      userId: "user-old",
    });
    const newest = insightsEvent(4, {
      installId: "install-a",
      receivedAtMs: 400,
      type: "RECOVERED",
      userId: "user-new",
    });
    const stale = insightsEvent(2, {
      installId: "install-a",
      receivedAtMs: 200,
      userId: "user-stale",
    });
    const other = insightsEvent(3, {
      installId: "install-b",
      receivedAtMs: 300,
      type: "UNCHANGED",
    });

    await insights.record({
      event: first,
      installation: toInsightsInstallationRow(first),
    });
    await insights.record({
      event: newest,
      installation: toInsightsInstallationRow(newest),
    });
    await insights.record({
      event: stale,
      installation: toInsightsInstallationRow(stale),
    });
    await insights.record({
      event: other,
      installation: toInsightsInstallationRow(other),
    });

    const firstPage = await insights.listEvents({
      filter: { kind: "all" },
      beforeReceivedAtMs: 500,
      limit: 2,
    });
    expect(firstPage.map(({ id }) => id)).toEqual([newest.id, other.id]);
    await expect(
      insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 500,
        after: {
          receivedAtMs: other.received_at_ms,
          id: other.id,
        },
        limit: 2,
      }),
    ).resolves.toEqual([stale, first]);
    await expect(
      insights.listEvents({
        filter: {
          kind: "installationMovement",
          installId: "install-a",
        },
        beforeReceivedAtMs: 500,
        limit: 10,
      }),
    ).resolves.toEqual([newest, stale, first]);

    await expect(
      insights.findInstallations({ installId: "install-a" }),
    ).resolves.toMatchObject([
      {
        id: newest.id,
        user_id: "user-new",
        received_at_ms: 400,
      },
    ]);
    await expect(
      insights.findInstallations({
        userId: "user-old",
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      insights.findInstallations({
        userId: "user-new",
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: newest.id, install_id: "install-a" }),
    ]);

    await expect(
      insights.countInstallations({
        platform: "ios",
        channel: "production",
        sinceMs: 250,
      }),
    ).resolves.toBe(2);
    await expect(
      insights.countInstallations({
        platform: "ios",
        channel: "production",
        sinceMs: 350,
      }),
    ).resolves.toBe(1);
  });

  it("uses the event id to break equal-timestamp latest-state ties", async () => {
    const insights = createPlugin().models.insights;
    const lower = insightsEvent(10, {
      installId: "install-tie",
      receivedAtMs: 1_000,
      userId: "user-lower",
    });
    const higher = insightsEvent(11, {
      installId: "install-tie",
      receivedAtMs: 1_000,
      userId: "user-higher",
    });

    await insights.record({
      event: higher,
      installation: toInsightsInstallationRow(higher),
    });
    await insights.record({
      event: lower,
      installation: toInsightsInstallationRow(lower),
    });

    await expect(
      insights.findInstallations({ installId: "install-tie" }),
    ).resolves.toMatchObject([{ id: higher.id, user_id: "user-higher" }]);
  });

  it("counts raw bundle outcomes and uses identical half-open list ranges", async () => {
    const insights = createPlugin().models.insights;
    const scope = { platform: "ios" as const, channel: "production" };
    const a = "00000000-0000-0000-0000-000000000001";
    const b = "00000000-0000-0000-0000-000000000002";
    const applied = insightsEvent(21, {
      installId: "bundle-test",
      receivedAtMs: 100,
    });
    const recovered = {
      ...insightsEvent(22, {
        installId: "bundle-test",
        receivedAtMs: 200,
        type: "RECOVERED",
      }),
      from_bundle_id: b,
      to_bundle_id: a,
    } as BundleEventRow;
    const adopted = {
      ...insightsEvent(23, {
        installId: "other",
        receivedAtMs: 200,
        type: "RELEASE_ADOPTED",
      }),
      from_bundle_id: b,
    } as BundleEventRow;
    const excluded = insightsEvent(24, {
      installId: "other",
      receivedAtMs: 300,
    });
    for (const event of [applied, recovered, adopted, excluded]) {
      await insights.record({
        event,
        installation: toInsightsInstallationRow(event),
      });
    }
    const filter = { ...scope, type: "RECOVERED" as const, fromBundleId: b };
    await expect(
      insights.countEvents({ filter, sinceMs: 200, beforeReceivedAtMs: 300 }),
    ).resolves.toBe(1);
    await expect(
      insights.listEvents({
        filter: { kind: "bundle", ...filter },
        sinceMs: 200,
        beforeReceivedAtMs: 300,
        limit: 10,
      }),
    ).resolves.toEqual([recovered]);
    await expect(
      insights.countEvents({
        filter: { ...filter, fromBundleId: a },
        sinceMs: 0,
        beforeReceivedAtMs: 300,
      }),
    ).resolves.toBe(0);
    await expect(
      insights.countEvents({
        filter: { ...scope, type: "UPDATE_APPLIED", toBundleId: b },
        sinceMs: 0,
        beforeReceivedAtMs: 300,
      }),
    ).resolves.toBe(1);
    await expect(
      insights.countEvents({
        filter: { ...scope, type: "RELEASE_ADOPTED", toBundleId: b },
        sinceMs: 0,
        beforeReceivedAtMs: 300,
      }),
    ).resolves.toBe(1);
    await expect(
      insights.countInstallations({ ...scope, sinceMs: 0, bundleId: a }),
    ).resolves.toBe(1);
    await expect(
      insights.countInstallations({ ...scope, sinceMs: 0, bundleId: b }),
    ).resolves.toBe(1);
    await expect(
      insights.countEvents({ filter, sinceMs: 200, beforeReceivedAtMs: 200 }),
    ).resolves.toBe(0);
  });

  it("rolls back both canonical records when a native transaction condition fails", async () => {
    const insights = createDynamoDBInsightsTable({
      client: fixture.client,
      tableName: fixture.tableName,
    });
    const event = insightsEvent(31, { installId: "atomic", receivedAtMs: 100 });
    const input = { event, installation: toInsightsInstallationRow(event) };
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
      insights.findInstallations({ installId: event.install_id }),
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
      insights.findInstallations({ installId: event.install_id }),
    ).resolves.toEqual([input.installation]);
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
    const input = { event, installation: toInsightsInstallationRow(event) };
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
      installation: toInsightsInstallationRow(reused),
    });
    await expect(
      insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 1_000,
        limit: 10,
      }),
    ).resolves.toEqual([event]);
    await expect(
      insights.findInstallations({ installId: event.install_id }),
    ).resolves.toEqual([input.installation]);
    await expect(
      insights.findInstallations({ installId: reused.install_id }),
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
        installation: toInsightsInstallationRow(event),
      });
    await fixture.client.send(
      new PutCommand({
        TableName: fixture.tableName,
        Item: {
          pk: "_hot-updater#insights-user#old",
          sk: "a",
          order_key: `0000000000000100#${previous.id}`,
          version: 1,
          row: toInsightsInstallationRow(previous),
        },
      }),
    );
    await expect(
      insights.findInstallations({ userId: "old", limit: 1 }),
    ).resolves.toEqual([toInsightsInstallationRow(valid)]);
  });

  it("does not count an installation again when its receipt time advances between native pages", async () => {
    const writer = createPlugin().models.insights;
    const first = insightsEvent(61, { installId: "a", receivedAtMs: 100 });
    const second = insightsEvent(62, { installId: "b", receivedAtMs: 100 });
    for (const event of [first, second])
      await writer.record({
        event,
        installation: toInsightsInstallationRow(event),
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
      const count = insights.countInstallations({
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
        installation: toInsightsInstallationRow(newer),
      });
      pause.release();
      await expect(count).resolves.toBe(2);
    } finally {
      pause.release();
      pause.remove();
      fixture.client.middlewareStack.remove(name);
    }
  });

  it("backfills legacy events without changing canonical state and is safe to repeat", async () => {
    const event = insightsEvent(71, { installId: "legacy", receivedAtMs: 100 });
    const installation = toInsightsInstallationRow(event);
    const orderKey = `0000000000000100#${event.id}`;
    await fixture.client.send(
      new PutCommand({
        TableName: fixture.tableName,
        Item: { pk: "bundle_events", sk: orderKey, version: 1, row: event },
      }),
    );
    await fixture.client.send(
      new PutCommand({
        TableName: fixture.tableName,
        Item: {
          pk: DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
          sk: event.install_id,
          version: 1,
          order_key: orderKey,
          row: installation,
        },
      }),
    );
    const insights = createPlugin().models.insights;
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
    await expect(insights.countEvents(query)).rejects.toThrow(
      "migrateDynamoDBInsights",
    );
    await fixture.migrateInsights();
    await fixture.migrateInsights();
    await expect(insights.countEvents(query)).resolves.toBe(1);
    await insights.record({ event, installation });
    await expect(
      insights.findInstallations({ installId: event.install_id }),
    ).resolves.toEqual([installation]);
    await expect(
      insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 200,
        limit: 10,
      }),
    ).resolves.toEqual([event]);
  });

  it("serializes concurrent equal-time reports while preserving both events", async () => {
    const insights = createPlugin().models.insights;
    const low = insightsEvent(81, {
      installId: "concurrent",
      receivedAtMs: 100,
      userId: "low",
    });
    const high = insightsEvent(82, {
      installId: "concurrent",
      receivedAtMs: 100,
      userId: "high",
    });
    await Promise.all(
      [low, high].map((event) =>
        insights.record({
          event,
          installation: toInsightsInstallationRow(event),
        }),
      ),
    );
    await expect(
      insights.findInstallations({ installId: "concurrent" }),
    ).resolves.toEqual([toInsightsInstallationRow(high)]);
    await expect(
      insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 200,
        limit: 10,
      }),
    ).resolves.toEqual([high, low]);
    await expect(
      insights.findInstallations({ userId: "low", limit: 10 }),
    ).resolves.toEqual([]);
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
      installation: toInsightsInstallationRow(event),
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
      insights.findInstallations({ installId: event.install_id }),
    ).resolves.toEqual([toInsightsInstallationRow(event)]);
    await expect(
      insights.countEvents({
        filter: { ...filter, channel: `${channel}나` },
        ...range,
      }),
    ).resolves.toBe(0);
  });
});
