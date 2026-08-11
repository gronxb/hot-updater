import {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { bundleToRow } from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dynamoDB } from "./dynamoDB";

const cloudFront = mockClient(CloudFrontClient);
const documentClient = mockClient(DynamoDBDocumentClient);
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
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "hash",
  gitCommitHash: null,
  message: null,
  channel: "production",
  storageUri: "storage://bundle",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  metadata: {},
});

const commitBundle = (plugin: ReturnType<typeof dynamoDB>) =>
  plugin.commit({
    mutations: [
      {
        operation: "insert",
        bundleId: bundleRow.id,
        changes: [{ table: "bundles", operation: "insert", row: bundleRow }],
      },
    ],
  });

describe("dynamoDB CloudFront lifecycle", () => {
  beforeEach(() => {
    cloudFront.reset();
    documentClient.reset();
    cloudFront.on(CreateInvalidationCommand).resolves({});
    documentClient.on(QueryCommand).resolves({ Items: [] });
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
        Paths: { Items: ["/api/check-update/*"] },
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

  it("exposes only the flat official database contract", async () => {
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    expect(plugin.bundles).toBeDefined();
    expect(plugin.bundlePatches).toBeDefined();
    expect(plugin.analytics).toBeDefined();
    expect(plugin.clientAccessKeys).toBeDefined();
    expect(plugin.commit).toBeTypeOf("function");
    expect(plugin).not.toHaveProperty("componentData");
    expect(plugin).not.toHaveProperty("create");
    expect(plugin).not.toHaveProperty("findMany");
    expect(plugin).not.toHaveProperty("transaction");
    expect(plugin).not.toHaveProperty("onDatabaseUpdated");
    expect(plugin).not.toHaveProperty("onUnmount");

    await plugin.dispose?.();
  });
});
