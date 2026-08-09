import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { dynamodbDatabase } from "./dynamodbDatabase";

const cloudFront = mockClient(CloudFrontClient);

describe("dynamodbDatabase CloudFront lifecycle", () => {
  beforeEach(() => {
    cloudFront.reset();
    cloudFront.on(CreateInvalidationCommand).resolves({});
  });

  it("invalidates cached update checks after metadata mutations", async () => {
    // Given
    const plugin = dynamodbDatabase({
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

    await plugin.onUnmount?.();
  });
});
