import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { bundleToRow } from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { loadBundleItemsById } from "./dynamoDB";
import { toDynamoDBBundleItem } from "./dynamoDB";

const dynamodb = mockClient(DynamoDBDocumentClient);
const tableName = "hot-updater-metadata";
const bundle = toDynamoDBBundleItem(
  bundleToRow({
    id: "00000000-0000-0000-0000-000000000001",
    platform: "ios",
    shouldForceUpdate: false,
    enabled: true,
    fileHash: "hash",
    gitCommitHash: null,
    message: null,
    channel: "production",
    storageUri: "storage://bundle.zip",
    targetAppVersion: "1.0.0",
    fingerprintHash: null,
    metadata: {},
  }),
);

const createStore = () => ({
  client: DynamoDBDocumentClient.from(
    new DynamoDBClient({
      credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
      },
      region: "us-east-1",
    }),
  ),
  tableName,
});

describe("DynamoDB batch reads", () => {
  beforeEach(() => dynamodb.reset());

  it("stops retrying keys that remain unprocessed after five attempts", async () => {
    dynamodb.on(BatchGetCommand).callsFake(() => {
      if (dynamodb.commandCalls(BatchGetCommand).length <= 5) {
        return {
          UnprocessedKeys: {
            [tableName]: { Keys: [{ pk: bundle.pk, sk: bundle.sk }] },
          },
        };
      }
      return { Responses: { [tableName]: [bundle] } };
    });

    await expect(
      loadBundleItemsById(createStore(), [bundle.sk]),
    ).rejects.toMatchObject({ name: "DynamoDBBatchGetExhaustedError" });
    expect(dynamodb.commandCalls(BatchGetCommand)).toHaveLength(5);
  });
});
