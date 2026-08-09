import path from "path";
import { fileURLToPath } from "url";

import {
  CreateTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  PutItemCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DYNAMODB_ANALYTICS_SCHEMA_KEY,
  DYNAMODB_ANALYTICS_SCHEMA_VERSION,
  DYNAMODB_UPDATE_INDEX_NAME,
} from "@hot-updater/aws";
import type { Bundle } from "@hot-updater/core";
import { createDatabaseClient } from "@hot-updater/plugin-core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import { standaloneRepository } from "@hot-updater/standalone";
import {
  setupBundleMethodsTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import {
  assertDockerComposeAvailable,
  cleanupServer,
  createGetUpdateInfo,
  killPort,
  spawnServerProcess,
  TEST_MANAGEMENT_AUTH_TOKEN,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const port = 13596;
const dynamodbPort = 21596;
const minioPort = 22596;
const region = "us-east-1";
const accessKeyId = "minioadmin";
const secretAccessKey = "minioadmin";
const tableName = "hot-updater-metadata";
const bucketName = "hot-updater-bundles";
const dynamodbEndpoint = `http://localhost:${dynamodbPort}`;
const s3Endpoint = `http://localhost:${minioPort}`;

assertDockerComposeAvailable(
  "Hono + DynamoDB integration tests require Docker Compose and a running Docker daemon.",
);

const credentials = { accessKeyId, secretAccessKey };

async function waitForDynamoDB(client: DynamoDBClient) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await client.send(new ListTablesCommand({ Limit: 1 }));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`DynamoDB Local did not become ready at ${dynamodbEndpoint}`);
}

async function createTable() {
  const client = new DynamoDBClient({
    region,
    endpoint: dynamodbEndpoint,
    credentials,
  });
  await waitForDynamoDB(client);
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
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
    { client, maxWaitTime: 30 },
    { TableName: tableName },
  );
  await client.send(
    new PutItemCommand({
      TableName: tableName,
      Item: {
        pk: { S: DYNAMODB_ANALYTICS_SCHEMA_KEY.pk },
        sk: { S: DYNAMODB_ANALYTICS_SCHEMA_KEY.sk },
        value: { S: DYNAMODB_ANALYTICS_SCHEMA_VERSION },
      },
    }),
  );
  client.destroy();
}

async function createBucket() {
  const client = new S3Client({
    region,
    endpoint: s3Endpoint,
    credentials,
    forcePathStyle: true,
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucketName }));
      client.destroy();
      return;
    } catch {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucketName }));
        client.destroy();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  client.destroy();
  throw new Error(`Could not create local S3 bucket ${bucketName}`);
}

describe("Hot Updater Handler Integration Tests (Hono + DynamoDB)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let hotUpdater: HotUpdaterAPI;

  beforeAll(async () => {
    await killPort(port);
    baseUrl = `http://localhost:${port}`;

    const composeEnv = {
      ...process.env,
      DYNAMODB_PORT: String(dynamodbPort),
      MINIO_API_PORT: String(minioPort),
      MINIO_CONSOLE_PORT: String(minioPort + 1),
      COMPOSE_PROJECT_NAME: `hot-updater-hono-dynamodb-${port}`,
    };
    await execa("docker", ["compose", "up", "-d", "--remove-orphans"], {
      cwd: projectRoot,
      env: composeEnv,
    });
    await createTable();
    await createBucket();

    const serviceEnv = {
      NODE_ENV: "test",
      AWS_REGION: region,
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_DYNAMODB_ENDPOINT: dynamodbEndpoint,
      AWS_DYNAMODB_TABLE_NAME: tableName,
      AWS_S3_ENDPOINT: s3Endpoint,
      AWS_S3_BUCKET_NAME: bucketName,
    };
    Object.assign(process.env, serviceEnv);
    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath: "",
      projectRoot,
      env: serviceEnv,
    });
    await waitForServer(baseUrl, 180);

    const db = await import("./db.js");
    hotUpdater = db.hotUpdater;
  }, 120000);

  afterAll(async () => {
    await cleanupServer(baseUrl, serverProcess, "");
    await execa("docker", ["compose", "down", "-v", "--remove-orphans"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DYNAMODB_PORT: String(dynamodbPort),
        MINIO_API_PORT: String(minioPort),
        MINIO_CONSOLE_PORT: String(minioPort + 1),
        COMPOSE_PROJECT_NAME: `hot-updater-hono-dynamodb-${port}`,
      },
    });
  }, 60000);

  const getUpdateInfo: ReturnType<typeof createGetUpdateInfo> = (
    bundles,
    options,
  ) =>
    createGetUpdateInfo({ baseUrl: `${baseUrl}/hot-updater` })(
      bundles,
      options,
    );

  setupGetUpdateInfoTestSuite({ getUpdateInfo });

  setupBundleMethodsTestSuite({
    getBundleById: (id: string) => hotUpdater.getBundleById(id),
    getChannels: () => hotUpdater.getChannels(),
    insertBundle: (bundle: Bundle) => hotUpdater.insertBundle(bundle),
    getBundles: (options) => hotUpdater.getBundles(options),
    updateBundleById: (bundleId: string, bundle: Partial<Bundle>) =>
      hotUpdater.updateBundleById(bundleId, bundle),
    deleteBundleById: (bundleId: string) =>
      hotUpdater.deleteBundleById(bundleId),
  });

  it("updates metadata through the authenticated standalone repository", async () => {
    const database = standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater`,
      commonHeaders: {
        Authorization: `Bearer ${TEST_MANAGEMENT_AUTH_TOKEN}`,
      },
    });
    const client = createDatabaseClient(database);
    const bundleId = "hono-dynamodb-update-target-app-version";

    await client.insertBundle({
      id: bundleId,
      platform: "ios",
      shouldForceUpdate: false,
      enabled: true,
      fileHash: `${bundleId}-hash`,
      gitCommitHash: null,
      message: null,
      channel: "production",
      targetAppVersion: "1.x.x",
      storageUri: `s3://${bucketName}/${bundleId}.zip`,
      fingerprintHash: null,
      rolloutCohortCount: 1000,
    });
    await client.updateBundleById(bundleId, {
      targetAppVersion: "1.0.2",
    });

    expect(await hotUpdater.getBundleById(bundleId)).toMatchObject({
      id: bundleId,
      targetAppVersion: "1.0.2",
    });
  });
});
