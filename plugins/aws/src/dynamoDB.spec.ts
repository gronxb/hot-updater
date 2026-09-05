import { createHash } from "node:crypto";

import {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  bundleToRow,
  type BundleEventRow,
  type InsightsListEventsInput,
  type InsightsFindInstallationsInput,
  type InsightsInstallationRow,
  toInsightsInstallationRow,
} from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DYNAMODB_INSIGHTS_EVENT_IDS_PARTITION,
  DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
  DYNAMODB_UPDATE_INDEX_NAME,
  dynamoDB,
  migrateDynamoDBInsights,
} from "./dynamoDB";

const cloudFront = mockClient(CloudFrontClient);
const documentClient = mockClient(DynamoDBDocumentClient);
const productionChannel = {
  id: "00000000-0000-0000-0000-000000000100",
  name: "production",
} as const;
const cloudFrontInvalidation = (status: string) => ({
  Id: "invalidation-id",
  Status: status,
  CreateTime: new Date(0),
  InvalidationBatch: {
    CallerReference: "fixture",
    Paths: { Quantity: 0, Items: [] },
  },
});
const bundleRow = bundleToRow({
  id: "00000000-0000-0000-0000-000000000001",
  platform: "ios",
  fileHash: "hash",
  gitCommitHash: null,
  storageUri: "storage://bundle",
  archiveByteSize: 3_000_000_001,
  metadata: {},
});

const commitBundle = (plugin: ReturnType<typeof dynamoDB>) =>
  plugin.commit({
    changes: [
      {
        model: "channels",
        operation: "insert",
        row: productionChannel,
        onConflict: "ignore",
      },
      { model: "bundles", operation: "insert", row: bundleRow },
    ],
  });

const insightsEvent = (index: number): BundleEventRow => ({
  id: `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
  type: "UPDATE_APPLIED",
  install_id: `install-${index}`,
  user_id: null,
  username: null,
  from_release_id: null,
  from_bundle_id: bundleRow.id,
  to_release_id: null,
  to_bundle_id: bundleRow.id,
  platform: "ios",
  app_version: "1.0.0",
  channel: productionChannel.name,
  cohort: "0",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: index,
});

const insightsInstallation = (
  index: number,
  userId: string,
): InsightsInstallationRow => {
  const event = insightsEvent(index);
  return {
    id: event.id,
    install_id: event.install_id,
    user_id: userId,
    username: event.username,
    to_bundle_id: event.to_bundle_id,
    type: event.type,
    platform: event.platform,
    app_version: event.app_version,
    channel: event.channel,
    cohort: event.cohort,
    received_at_ms: event.received_at_ms,
  };
};

describe("dynamoDB CloudFront lifecycle", () => {
  beforeEach(() => {
    cloudFront.reset();
    documentClient.reset();
    cloudFront.on(CreateInvalidationCommand).resolves({});
    documentClient.on(GetCommand).resolves({});
    documentClient.on(PutCommand).resolves({});
    documentClient.on(QueryCommand).resolves({ Items: [] });
    documentClient.on(ScanCommand).resolves({ Items: [] });
    documentClient.on(TransactWriteCommand).resolves({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invalidates cached update checks after a successful commit", async () => {
    // Given
    const plugin = dynamoDB({
      cloudfrontDistributionId: "distribution-id",
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    // When
    await commitBundle(plugin);

    // Then
    expect(
      cloudFront.commandCalls(CreateInvalidationCommand)[0]?.args[0].input,
    ).toMatchObject({
      DistributionId: "distribution-id",
      InvalidationBatch: {
        Paths: { Items: ["/release-catalogs/*"] },
      },
    });
    expect(cloudFront.commandCalls(GetInvalidationCommand)).toHaveLength(0);

    await plugin.dispose?.();
  });

  it("waits for invalidation completion when configured", async () => {
    // Given
    vi.useFakeTimers();
    cloudFront.on(CreateInvalidationCommand).resolves({
      Invalidation: cloudFrontInvalidation("InProgress"),
    });
    cloudFront.on(GetInvalidationCommand).resolves({
      Invalidation: cloudFrontInvalidation("Completed"),
    });
    const plugin = dynamoDB({
      cloudfrontDistributionId: "distribution-id",
      region: "us-east-1",
      shouldWaitForInvalidation: true,
      tableName: "hot-updater-metadata",
    });

    // When
    const mutation = commitBundle(plugin);
    await vi.advanceTimersByTimeAsync(2_000);
    await mutation;

    // Then
    expect(cloudFront.commandCalls(GetInvalidationCommand)).toHaveLength(1);

    await plugin.dispose?.();
  });

  it("uses the database factory naming convention", async () => {
    // Given
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    // Then
    expect(plugin.name).toBe("dynamoDB");

    await plugin.dispose?.();
  });

  it("exposes only the nested official database contract", async () => {
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    expect(plugin.models.bundles).toBeDefined();
    expect(plugin.models.bundlePatches).toBeDefined();
    expect(plugin.models.channels).toBeDefined();
    expect(plugin.models.insights).toBeDefined();
    expect(plugin.models.apiKeys).toBeDefined();
    expect(plugin).not.toHaveProperty("queries");
    expect(typeof plugin.commit).toBe("function");
    expect(plugin).not.toHaveProperty("bundles");
    expect(plugin).not.toHaveProperty("bundlePatches");
    expect(plugin).not.toHaveProperty("insights");
    expect(plugin).not.toHaveProperty("apiKeys");
    expect(plugin).not.toHaveProperty("getUpdateInfo");
    expect(plugin).not.toHaveProperty("componentData");
    expect(plugin).not.toHaveProperty("create");
    expect(plugin).not.toHaveProperty("findMany");
    expect(plugin).not.toHaveProperty("transaction");
    expect(plugin).not.toHaveProperty("onDatabaseUpdated");
    expect(plugin).not.toHaveProperty("onUnmount");

    await plugin.dispose?.();
  });

  it("rejects invalid direct event-page queries", async () => {
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });
    const valid: InsightsListEventsInput = {
      filter: { kind: "all" },
      beforeReceivedAtMs: 100,
      limit: 10,
    };
    const invalid: InsightsListEventsInput[] = [
      { ...valid, limit: 0 },
      { ...valid, limit: 102 },
      { ...valid, beforeReceivedAtMs: -1 },
      { ...valid, after: { receivedAtMs: -1, id: "cursor" } },
      { ...valid, after: { receivedAtMs: 100, id: "cursor" } },
      {
        ...valid,
        filter: { kind: "installationMovement", installId: "" },
      },
    ];

    for (const input of invalid) {
      await expect(plugin.models.insights.listEvents(input)).rejects.toEqual(
        expect.objectContaining({
          name: "DatabasePluginInputError",
          code: "invalid-query",
        }),
      );
    }
    expect(documentClient.commandCalls(QueryCommand)).toHaveLength(0);

    await plugin.dispose?.();
  });

  it("rejects invalid direct installation queries", async () => {
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });
    const valid: InsightsFindInstallationsInput = {
      userId: "user-1",
      limit: 10,
    };
    const invalid: InsightsFindInstallationsInput[] = [
      { ...valid, userId: "" },
      { ...valid, limit: 0 },
      { ...valid, limit: 102 },
      { ...valid, afterInstallId: "" },
    ];

    for (const input of invalid) {
      await expect(
        plugin.models.insights.findInstallations(input),
      ).rejects.toMatchObject({
        name: "DatabasePluginInputError",
        code: "invalid-query",
      });
    }
    await expect(
      plugin.models.insights.findInstallations({ installId: "" }),
    ).rejects.toMatchObject({
      name: "DatabasePluginInputError",
      code: "invalid-query",
    });
    await expect(
      plugin.models.insights.countInstallations({
        platform: "ios",
        channel: "production",
        sinceMs: -1,
      }),
    ).rejects.toMatchObject({
      name: "DatabasePluginInputError",
      code: "invalid-query",
    });
    expect(documentClient.commandCalls(QueryCommand)).toHaveLength(0);
    expect(documentClient.commandCalls(GetCommand)).toHaveLength(0);

    await plugin.dispose?.();
  });

  it("lists channels from their dedicated partition without scanning", async () => {
    documentClient.on(QueryCommand).resolves({ Items: [] });
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [],
    });

    expect(documentClient.commandCalls(QueryCommand)).toHaveLength(1);
    const query = documentClient.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(query).toMatchObject({
      ConsistentRead: true,
    });
    expect(query?.KeyConditionExpression).toMatch(/^#\w+ = :\w+$/);
    expect(Object.values(query?.ExpressionAttributeValues ?? {})).toContain(
      "channels",
    );
    expect(documentClient.commandCalls(ScanCommand)).toHaveLength(0);
    await plugin.dispose?.();
  });

  it.each([
    { from_release_id: undefined },
    { to_release_id: undefined },
    { from_bundle_id: null },
    { to_bundle_id: null },
    { type: "UNCHANGED", from_bundle_id: bundleRow.id, update_strategy: null },
  ])("rejects an invalid stored Insights row", async (overrides) => {
    documentClient.on(QueryCommand).resolves({
      Items: [
        {
          pk: "bundle_events",
          sk: "0000000000000001#event",
          version: 1,
          row: { ...insightsEvent(1), ...overrides },
        },
      ],
    });
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    await expect(
      plugin.models.insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 2,
        limit: 1,
      }),
    ).rejects.toMatchObject({ name: "DynamoDBStoredItemError" });

    await plugin.dispose?.();
  });

  it("preserves explicit null Release ids on a stored Insights row", async () => {
    const row = insightsEvent(1);
    documentClient.on(QueryCommand).resolves({
      Items: [
        {
          pk: "bundle_events",
          sk: "0000000000000001#event",
          version: 1,
          row,
        },
      ],
    });
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    await expect(
      plugin.models.insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 2,
        limit: 1,
      }),
    ).resolves.toEqual([row]);

    await plugin.dispose?.();
  });

  it("keeps event reads bounded after a cursor beyond 50,000 rows", async () => {
    const row = insightsEvent(50_000);
    documentClient.on(QueryCommand).resolves({
      Items: [
        {
          pk: "bundle_events",
          sk: "0000000000050000#event",
          version: 1,
          row,
        },
      ],
    });
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    await expect(
      plugin.models.insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 60_000,
        after: {
          receivedAtMs: 50_001,
          id: insightsEvent(50_001).id,
        },
        limit: 101,
      }),
    ).resolves.toEqual([row]);

    const query = documentClient.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(query).toMatchObject({
      ConsistentRead: true,
      Limit: 101,
      ScanIndexForward: false,
    });
    expect(query?.ExpressionAttributeValues).toMatchObject({
      ":partition": "bundle_events",
      ":upper": `0000000000050001#${insightsEvent(50_001).id.slice(0, -1)}0~`,
    });
    expect(documentClient.commandCalls(ScanCommand)).toHaveLength(0);

    await plugin.dispose?.();
  });

  it("continues an event page after DynamoDB's response-size boundary", async () => {
    const rows = [insightsEvent(3), insightsEvent(2), insightsEvent(1)];
    const lastEvaluatedKey = {
      pk: "bundle_events",
      sk: `0000000000000003#${rows[0]?.id}`,
    };
    documentClient
      .on(QueryCommand)
      .resolvesOnce({
        Items: [
          {
            ...lastEvaluatedKey,
            version: 1,
            row: rows[0],
          },
        ],
        LastEvaluatedKey: lastEvaluatedKey,
      })
      .resolvesOnce({
        Items: rows.slice(1).map((row) => ({
          pk: "bundle_events",
          sk: `${String(row.received_at_ms).padStart(16, "0")}#${row.id}`,
          version: 1,
          row,
        })),
      });
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    await expect(
      plugin.models.insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 4,
        limit: 3,
      }),
    ).resolves.toEqual(rows);

    const queries = documentClient.commandCalls(QueryCommand);
    expect(queries).toHaveLength(2);
    expect(queries[1]?.args[0].input).toMatchObject({
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 2,
    });

    await plugin.dispose?.();
  });

  it("reads installation movement from the existing secondary index", async () => {
    const row = insightsEvent(3);
    documentClient.on(QueryCommand).resolves({
      Items: [
        {
          pk: "bundle_events",
          sk: "0000000000000003#event",
          version: 1,
          row,
        },
      ],
    });
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    await expect(
      plugin.models.insights.listEvents({
        filter: {
          kind: "installationMovement",
          installId: row.install_id,
        },
        beforeReceivedAtMs: 4,
        limit: 10,
      }),
    ).resolves.toEqual([row]);

    expect(
      documentClient.commandCalls(QueryCommand)[0]?.args[0].input,
    ).toMatchObject({
      IndexName: DYNAMODB_UPDATE_INDEX_NAME,
      Limit: 10,
      ScanIndexForward: false,
      ExpressionAttributeValues: {
        ":partition": `_hot-updater#insights-movement#${row.install_id}`,
        ":upper": '0000000000000004"~',
      },
    });

    await plugin.dispose?.();
  });

  it("continues a user page after DynamoDB's response-size boundary", async () => {
    const userId = "user-1";
    const partition = `_hot-updater#insights-user#${userId}`;
    const rows = [
      insightsInstallation(1, userId),
      insightsInstallation(2, userId),
      insightsInstallation(3, userId),
    ];
    const toItem = (row: InsightsInstallationRow) => ({
      pk: partition,
      sk: row.install_id,
      order_key: `${String(row.received_at_ms).padStart(16, "0")}#${row.id}`,
      version: 1,
      row,
    });
    const lastEvaluatedKey = {
      pk: partition,
      sk: rows[0]?.install_id,
    };
    for (const row of rows) {
      documentClient
        .on(GetCommand, {
          Key: {
            pk: DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
            sk: row.install_id,
          },
        })
        .resolves({
          Item: {
            ...toItem(row),
            pk: DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
          },
        });
    }
    documentClient
      .on(QueryCommand)
      .resolvesOnce({
        Items: [toItem(rows[0]!)],
        LastEvaluatedKey: lastEvaluatedKey,
      })
      .resolvesOnce({ Items: rows.slice(1).map(toItem) });
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    await expect(
      plugin.models.insights.findInstallations({
        userId,
        limit: 3,
      }),
    ).resolves.toEqual(rows);

    const queries = documentClient.commandCalls(QueryCommand);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.args[0].input.ExpressionAttributeNames).toEqual({
      "#pk": "pk",
    });
    expect(queries[1]?.args[0].input).toMatchObject({
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 2,
    });

    await plugin.dispose?.();
  });

  it("atomically records the ID, bundle index, latest, and user access rows", async () => {
    const previousEvent = { ...insightsEvent(1), user_id: "old-user" };
    const previous = {
      id: previousEvent.id,
      install_id: previousEvent.install_id,
      user_id: previousEvent.user_id,
      username: previousEvent.username,
      to_bundle_id: previousEvent.to_bundle_id,
      type: previousEvent.type,
      platform: previousEvent.platform,
      app_version: previousEvent.app_version,
      channel: previousEvent.channel,
      cohort: previousEvent.cohort,
      received_at_ms: previousEvent.received_at_ms,
    };
    documentClient
      .on(GetCommand, {
        Key: { pk: "_hot-updater", sk: "insights-contract-v1" },
      })
      .resolves({ Item: { version: 1 } });
    documentClient
      .on(GetCommand, {
        Key: {
          pk: DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
          sk: previous.install_id,
        },
      })
      .resolves({
        Item: {
          pk: DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
          sk: previous.install_id,
          order_key: `0000000000000001#${previous.id}`,
          version: 1,
          row: previous,
        },
      });
    const next = {
      ...insightsEvent(2),
      install_id: previous.install_id,
      user_id: "new-user",
    };
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    await plugin.models.insights.record({
      event: next,
      installation: toInsightsInstallationRow(next),
    });

    const transaction =
      documentClient.commandCalls(TransactWriteCommand)[0]?.args[0].input
        .TransactItems;
    expect(transaction).toHaveLength(6);
    expect(transaction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              pk: DYNAMODB_INSIGHTS_EVENT_IDS_PARTITION,
              sk: next.id,
            }),
            ConditionExpression: "attribute_not_exists(#pk)",
          }),
        }),
        expect.objectContaining({
          Delete: expect.objectContaining({
            Key: {
              pk: "_hot-updater#insights-user#old-user",
              sk: previous.install_id,
            },
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              pk: "_hot-updater#insights-user#new-user",
              sk: previous.install_id,
            }),
          }),
        }),
      ]),
    );

    await plugin.dispose?.();
  });

  it("counts every canonical installation page with a stable install-ID cursor", async () => {
    const queryMock = documentClient.on(QueryCommand);
    for (let index = 1; index <= 11; index++) {
      queryMock.resolvesOnce({
        Count: 5_000,
        LastEvaluatedKey: {
          pk: DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
          sk: `active-page-${index}`,
        },
      });
    }
    queryMock.resolvesOnce({ Count: 1 });
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    await expect(
      plugin.models.insights.countInstallations({
        platform: "ios",
        channel: "production",
        sinceMs: 1_000,
      }),
    ).resolves.toBe(55_001);

    const queries = documentClient.commandCalls(QueryCommand);
    expect(queries).toHaveLength(12);
    for (const query of queries) {
      expect(query.args[0].input).toMatchObject({
        ConsistentRead: true,
        Select: "COUNT",
        ExpressionAttributeValues: {
          ":pk": DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
          ":since": 1_000,
          ":platform": "ios",
          ":channel": "production",
        },
      });
    }
    expect(queries[1]?.args[0].input.ExclusiveStartKey).toEqual({
      pk: DYNAMODB_INSIGHTS_INSTALLATIONS_PARTITION,
      sk: "active-page-1",
    });
    expect(documentClient.commandCalls(ScanCommand)).toHaveLength(0);

    await plugin.dispose?.();
  });

  it("continues native bundle COUNT pages and shares the list range", async () => {
    documentClient.on(GetCommand).resolves({ Item: { version: 1 } });
    const filter = {
      platform: "ios" as const,
      channel: "production",
      type: "RECOVERED" as const,
      fromBundleId: bundleRow.id,
    };
    const partition = `_hot-updater#insights-bundle#${createHash("sha256")
      .update(
        JSON.stringify([
          filter.platform,
          filter.channel,
          filter.type,
          filter.fromBundleId,
        ]),
        "utf8",
      )
      .digest("hex")}`;
    const key = { pk: partition, sk: "0000000000000002#event" };
    documentClient
      .on(QueryCommand)
      .resolvesOnce({ Count: 0, LastEvaluatedKey: key })
      .resolvesOnce({ Count: 4 });
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });
    await expect(
      plugin.models.insights.countEvents({
        filter,
        sinceMs: 1,
        beforeReceivedAtMs: 4,
      }),
    ).resolves.toBe(4);
    const queries = documentClient.commandCalls(QueryCommand);
    expect(queries).toHaveLength(2);
    expect(queries[1]?.args[0].input).toMatchObject({
      ExclusiveStartKey: key,
      Select: "COUNT",
    });
    const countRange = queries[0]?.args[0].input;
    documentClient.on(QueryCommand).resolves({ Items: [] });
    await plugin.models.insights.listEvents({
      filter: { kind: "bundle", ...filter },
      sinceMs: 1,
      beforeReceivedAtMs: 4,
      limit: 10,
    });
    const listRange =
      documentClient.commandCalls(QueryCommand)[2]?.args[0].input;
    expect(listRange?.KeyConditionExpression).toBe(
      countRange?.KeyConditionExpression,
    );
    expect(listRange?.ExpressionAttributeValues).toEqual(
      countRange?.ExpressionAttributeValues,
    );
    expect(countRange?.ExpressionAttributeValues).toMatchObject({
      ":partition": partition,
      ":since": "0000000000000001#",
    });
    expect(documentClient.commandCalls(ScanCommand)).toHaveLength(0);
    await plugin.dispose?.();
  });

  it("fails a multi-page bundle count instead of returning the earlier partial count", async () => {
    documentClient.on(GetCommand).resolves({ Item: { version: 1 } });
    documentClient
      .on(QueryCommand)
      .resolvesOnce({
        Count: 9,
        LastEvaluatedKey: { pk: "bundle-range", sk: "next" },
      })
      .rejectsOnce(new Error("count query failed"));
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });
    await expect(
      plugin.models.insights.countEvents({
        filter: {
          platform: "ios",
          channel: "production",
          type: "UPDATE_APPLIED",
          toBundleId: bundleRow.id,
        },
        sinceMs: 0,
        beforeReceivedAtMs: 100,
      }),
    ).rejects.toThrow("count query failed");
    await plugin.dispose?.();
  });

  it("resumes migration after failure without publishing a partial readiness marker", async () => {
    const config = { region: "us-east-1", tableName: "hot-updater-metadata" };
    const first = insightsEvent(1);
    const second = insightsEvent(2);
    const orderKey = (row: BundleEventRow) =>
      `${String(row.received_at_ms).padStart(16, "0")}#${row.id}`;
    documentClient.on(QueryCommand).resolves({
      Items: [first, second].map((row) => ({
        pk: "bundle_events",
        sk: orderKey(row),
        version: 1,
        row,
      })),
    });
    documentClient
      .on(TransactWriteCommand)
      .resolvesOnce({})
      .rejectsOnce(new Error("migration write failed"));
    await expect(migrateDynamoDBInsights(config)).rejects.toThrow(
      "migration write failed",
    );
    expect(documentClient.commandCalls(PutCommand)).toHaveLength(0);
    documentClient
      .on(GetCommand, {
        Key: { pk: DYNAMODB_INSIGHTS_EVENT_IDS_PARTITION, sk: first.id },
      })
      .resolves({ Item: { order_key: orderKey(first) } });
    documentClient.on(TransactWriteCommand).resolves({});
    await migrateDynamoDBInsights(config);
    const transactions = documentClient.commandCalls(TransactWriteCommand);
    expect(transactions).toHaveLength(3);
    expect(transactions[2]?.args[0].input.TransactItems).toHaveLength(2);
    expect(
      transactions[2]?.args[0].input.TransactItems?.[0]?.Put?.Item,
    ).toMatchObject({
      pk: DYNAMODB_INSIGHTS_EVENT_IDS_PARTITION,
      sk: second.id,
    });
    expect(documentClient.commandCalls(PutCommand)).toHaveLength(1);
    expect(
      documentClient.commandCalls(PutCommand)[0]?.args[0].input.Item,
    ).toEqual({ pk: "_hot-updater", sk: "insights-contract-v1", version: 1 });
  });
});
