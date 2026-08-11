import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { NIL_UUID, type Bundle } from "@hot-updater/core";
import { bundleToRow } from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { toDynamoDBBundleItem } from "./dynamoDB";
import { createDynamoDBGetUpdateInfo } from "./dynamoDB";

const dynamodb = mockClient(DynamoDBDocumentClient);

const bundle = (id: string, targetAppVersion: string): Bundle => ({
  id,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  message: null,
  channel: "production",
  storageUri: `storage://${id}.zip`,
  targetAppVersion,
  fingerprintHash: null,
  metadata: {},
});

describe("DynamoDB getUpdateInfo", () => {
  beforeEach(() => {
    dynamodb.reset();
  });

  it("selects an update without hydrating patches for every candidate", async () => {
    // Given
    const candidates = Array.from({ length: 100 }, (_, index) =>
      bundle(
        `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
        "1.x",
      ),
    );
    dynamodb.on(QueryCommand).callsFake((input) => {
      const offset = input.ExclusiveStartKey === undefined ? 0 : 50;
      return {
        Items: candidates
          .slice(offset, offset + 50)
          .map((candidate) => toDynamoDBBundleItem(bundleToRow(candidate))),
        ...(offset === 0
          ? { LastEvaluatedKey: { pk: "bundles", sk: candidates[49]?.id } }
          : {}),
      };
    });
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        credentials: {
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
        },
        region: "us-east-1",
      }),
    );
    const getUpdateInfo = createDynamoDBGetUpdateInfo(
      { client, tableName: "hot-updater-metadata" },
      "hot-updater-update-index",
    );

    // When
    const result = await getUpdateInfo({
      _updateStrategy: "appVersion",
      appVersion: "1.0.0",
      bundleId: NIL_UUID,
      channel: "production",
      platform: "ios",
    });

    // Then
    expect(result).toMatchObject({
      id: candidates.at(-1)?.id,
      status: "UPDATE",
    });
    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(2);
  });
});
