import {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { bundleToRow } from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dynamoDB } from "./dynamoDB";

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

describe("dynamoDB CloudFront lifecycle", () => {
  beforeEach(() => {
    cloudFront.reset();
    documentClient.reset();
    cloudFront.on(CreateInvalidationCommand).resolves({});
    documentClient.on(QueryCommand).resolves({ Items: [] });
    documentClient.on(ScanCommand).resolves({ Items: [] });
    documentClient.on(TransactWriteCommand).resolves({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a noncanonical Insights database namespace before I/O", () => {
    expect(() =>
      dynamoDB({
        insightsDatabaseNamespace: "NOT-A-UUID",
        region: "us-east-1",
        tableName: "hot-updater-metadata",
      }),
    ).toThrow("namespace must be a lowercase UUID");
    expect(documentClient.calls()).toHaveLength(0);
  });

  it("invalidates cached update checks after a successful commit", async () => {
    // Given
    const plugin = dynamoDB({
      insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000001",
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
      insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000001",
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
      insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000001",
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    // Then
    expect(plugin.name).toBe("dynamoDB");

    await plugin.dispose?.();
  });

  it("exposes only the nested official database contract", async () => {
    const plugin = dynamoDB({
      insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000001",
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    expect(plugin.models.bundles).toBeDefined();
    expect(plugin.models.bundlePatches).toBeDefined();
    expect(plugin.models.channels).toBeDefined();
    expect(plugin.models.insights).toBeDefined();
    expect(Object.keys(plugin.models.insights).sort()).toEqual([
      "append",
      "getReport",
      "pageEvents",
      "pageInstallations",
      "pageReport",
      "runMaintenanceStep",
    ]);
    expect(plugin.models.insights).not.toHaveProperty("scan");
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

  it("lists channels from their dedicated partition without scanning", async () => {
    documentClient.on(QueryCommand).resolves({ Items: [] });
    const plugin = dynamoDB({
      insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000001",
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

  it("rejects Insights passed through the generic commit port", async () => {
    const plugin = dynamoDB({
      insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000001",
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    await expect(
      plugin.commit({
        changes: [{ model: "insights", operation: "insert", row: {} }],
      } as never),
    ).rejects.toMatchObject({
      name: "DatabasePluginInputError",
    });
    expect(documentClient.commandCalls(TransactWriteCommand)).toHaveLength(0);
    await plugin.dispose?.();
  });
});
