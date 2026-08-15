import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { bundleToRow } from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { queryCompleteOwnerPatches } from "./dynamoDB";
import { toDynamoDBBundleItem, toDynamoDBPatchItem } from "./dynamoDB";

const dynamodb = mockClient(DynamoDBDocumentClient);
const ownerId = "00000000-0000-0000-0000-000000000001";
const bundleRow = bundleToRow(
  {
    id: ownerId,
    platform: "ios",
    shouldForceUpdate: false,
    enabled: true,
    fileHash: "hash",
    gitCommitHash: null,
    message: null,
    channel: "production",
    storageUri: "storage://bundle.zip",
    targetAppVersion: "1.x",
    fingerprintHash: null,
    metadata: {},
  },
  "00000000-0000-0000-0000-000000000100",
);
const patch = (sequence: number) => ({
  id: `patch-${sequence}`,
  bundle_id: ownerId,
  base_bundle_id: `00000000-0000-0000-0000-${sequence.toString().padStart(12, "0")}`,
  base_file_hash: `base-${sequence}`,
  patch_file_hash: `patch-${sequence}`,
  patch_storage_uri: `storage://patch-${sequence}`,
  order_index: sequence,
});
const tableName = "hot-updater-metadata";

const returnStrongPatches = (rows: ReturnType<typeof patch>[]) => {
  dynamodb.on(BatchGetCommand).callsFake((input) => {
    const keys = input.RequestItems?.[tableName]?.Keys ?? [];
    const requested = new Set(
      keys.flatMap((key: object) => {
        const sk = Reflect.get(key, "sk");
        return typeof sk === "string" ? [sk] : [];
      }),
    );
    return {
      Responses: {
        [tableName]: rows
          .filter(({ id }) => requested.has(id))
          .map((row) => toDynamoDBPatchItem(row)),
      },
    };
  });
};

describe("DynamoDB owner patch reads", () => {
  beforeEach(() => dynamodb.reset());

  it("checks the authoritative owner count and retries a lagging GSI", async () => {
    const patches = [patch(2), patch(3)];
    returnStrongPatches(patches);
    dynamodb.on(GetCommand).resolves({
      Item: toDynamoDBBundleItem(bundleRow, 1, 2, 2),
    });
    dynamodb.on(QueryCommand).callsFake(() => ({
      Items: patches
        .slice(0, dynamodb.commandCalls(QueryCommand).length)
        .map((row) => toDynamoDBPatchItem(row)),
    }));
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        credentials: {
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
        },
        region: "us-east-1",
      }),
    );

    await expect(
      queryCompleteOwnerPatches(
        { client, tableName },
        "hot-updater-update-index",
        ownerId,
      ),
    ).resolves.toEqual(patches);

    expect(dynamodb.commandCalls(GetCommand)).toHaveLength(1);
    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it("hydrates a same-count GSI result from the strongly consistent base table", async () => {
    const stale = patch(2);
    const latest = patch(3);
    returnStrongPatches([latest]);
    dynamodb.on(GetCommand).resolves({
      Item: toDynamoDBBundleItem(bundleRow, 2, 1, 1),
    });
    dynamodb
      .on(QueryCommand)
      .resolvesOnce({ Items: [toDynamoDBPatchItem(stale)] })
      .resolves({ Items: [toDynamoDBPatchItem(latest)] });
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        credentials: {
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
        },
        region: "us-east-1",
      }),
    );

    await expect(
      queryCompleteOwnerPatches(
        { client, tableName },
        "hot-updater-update-index",
        ownerId,
      ),
    ).resolves.toEqual([latest]);

    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(2);
    expect(dynamodb.commandCalls(BatchGetCommand)).toHaveLength(2);
  });
});
