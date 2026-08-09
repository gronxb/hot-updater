import {
  CreateTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  setupDatabasePluginTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertDockerDaemonAvailable,
  findOpenPort,
  formatRuntimeLogs,
  spawnRuntime,
  stopRuntime,
  type RuntimeChild,
  type RuntimeLogs,
} from "../../../packages/test-utils/src/runtimeProcess";
import {
  DYNAMODB_UPDATE_INDEX_NAME,
  dynamodbDatabase,
} from "./dynamodbDatabase";

const REGION = "us-east-1";
const TABLE_NAME = `hot-updater-${process.pid}-${Date.now()}`;
const LOCALSTACK_IMAGE = "localstack/localstack:3";
const credentials = {
  accessKeyId: "test",
  secretAccessKey: "test",
} as const;

let client: DynamoDBDocumentClient;
let endpoint = "";
let runtime:
  | { readonly child: RuntimeChild; readonly logs: RuntimeLogs }
  | undefined;

assertDockerDaemonAvailable(
  "DynamoDB database integration tests require a running Docker daemon.",
);

const createPlugin = (): DatabasePlugin =>
  dynamodbDatabase({
    credentials,
    endpoint,
    region: REGION,
    tableName: TABLE_NAME,
  });

const parseKey = (item: Record<string, unknown>) => {
  const pk = item.pk;
  const sk = item.sk;
  if (typeof pk !== "string" || typeof sk !== "string") {
    throw new Error("DynamoDB test row is missing its primary key");
  }
  return { pk, sk };
};

const clearTable = async (): Promise<void> => {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ExclusiveStartKey: exclusiveStartKey,
        ProjectionExpression: "#pk, #sk",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      }),
    );
    const keys = (page.Items ?? []).map(parseKey);
    for (let offset = 0; offset < keys.length; offset += 25) {
      await client.send(
        new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: keys.slice(offset, offset + 25).map((key) => ({
              DeleteRequest: { Key: key },
            })),
          },
        }),
      );
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
};

beforeAll(async () => {
  const port = await findOpenPort();
  endpoint = `http://127.0.0.1:${port}`;
  runtime = spawnRuntime({
    command: "docker",
    args: [
      "run",
      "--rm",
      "-p",
      `127.0.0.1:${port}:4566`,
      "-e",
      "SERVICES=dynamodb",
      "-e",
      `DEFAULT_REGION=${REGION}`,
      LOCALSTACK_IMAGE,
    ],
    cwd: process.cwd(),
  });

  const rawClient = new DynamoDBClient({
    credentials,
    endpoint,
    maxAttempts: 50,
    region: REGION,
  });
  client = DynamoDBDocumentClient.from(rawClient);
  try {
    await client.send(new ListTablesCommand({ Limit: 1 }));
    await rawClient.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          { AttributeName: "gsi1pk", AttributeType: "S" },
          { AttributeName: "gsi1sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: DYNAMODB_UPDATE_INDEX_NAME,
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      }),
    );
    await waitUntilTableExists(
      { client: rawClient, maxWaitTime: 30 },
      { TableName: TABLE_NAME },
    );
  } catch (error) {
    throw new Error(
      `DynamoDB test runtime failed: ${formatRuntimeLogs(runtime.logs)}`,
      { cause: error },
    );
  }
}, 120_000);

afterAll(async () => {
  client.destroy();
  if (runtime) await stopRuntime(runtime.child);
});

setupDatabasePluginTestSuite({
  name: "DynamoDB fixed-model database plugin",
  createPlugin,
  migrate: () => undefined,
  reset: clearTable,
  dispose: () => undefined,
});

setupGetUpdateInfoTestSuite({
  getUpdateInfo: async (bundles, args) => {
    await clearTable();
    const plugin = createPlugin();
    const database = createDatabaseClient(plugin);
    for (const bundle of bundles) await database.insertBundle(bundle);
    if (!plugin.getUpdateInfo) {
      throw new Error("DynamoDB database plugin has no update-check fast path");
    }
    return plugin.getUpdateInfo(args);
  },
});

describe("DynamoDB aggregate mutations", () => {
  beforeEach(clearTable);

  it("atomically inserts and replaces bundle patches", async () => {
    const database = createDatabaseClient(createPlugin());
    const baseBundle = {
      id: "00000000-0000-0000-0000-000000000901",
      platform: "ios",
      shouldForceUpdate: false,
      enabled: true,
      fileHash: "base-hash",
      gitCommitHash: null,
      message: "base",
      channel: "production",
      storageUri: "storage://base.zip",
      targetAppVersion: "1.0.0",
      fingerprintHash: null,
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
