import {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dynamoDB } from "./dynamoDB";

const cloudFront = mockClient(CloudFrontClient);
const cloudFrontInvalidation = (status: string) => ({
  Id: "invalidation-id",
  Status: status,
  CreateTime: new Date(0),
  InvalidationBatch: {
    CallerReference: "fixture",
    Paths: { Quantity: 0, Items: [] },
  },
});

describe("dynamoDB CloudFront lifecycle", () => {
  beforeEach(() => {
    cloudFront.reset();
    cloudFront.on(CreateInvalidationCommand).resolves({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invalidates cached update checks after metadata mutations", async () => {
    // Given
    const plugin = dynamoDB({
      cloudfrontDistributionId: "distribution-id",
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    // When
    await plugin.onDatabaseUpdated?.();

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

    await plugin.onUnmount?.();
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
    const invalidation = plugin.onDatabaseUpdated?.();
    await vi.advanceTimersByTimeAsync(2_000);
    await invalidation;

    // Then
    expect(cloudFront.commandCalls(GetInvalidationCommand)).toHaveLength(1);

    await plugin.onUnmount?.();
  });

  it("uses the database factory naming convention", async () => {
    // Given
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    // Then
    expect(plugin.name).toBe("dynamoDB");

    await plugin.onUnmount?.();
  });

  it("provides provider-neutral component data", () => {
    const plugin = dynamoDB({
      region: "us-east-1",
      tableName: "hot-updater-metadata",
    });

    expect(
      getCapabilityContributions(plugin).map(({ token }) => token.id),
    ).toEqual(["hot-updater.component-data.adapter@1"]);
  });
});
