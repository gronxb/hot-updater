import { generateKeyPairSync } from "node:crypto";
import { access, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CreateTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { transformEnv } from "@hot-updater/cli-tools";
import {
  type Bundle,
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";
import {
  commitReleaseCatalogMutations,
  createUUIDv7,
} from "@hot-updater/plugin-core";
import { createApiKey, createHotUpdater } from "@hot-updater/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertDockerDaemonAvailable,
  findOpenPort,
  formatRuntimeLogs,
  runCheckedCommand,
  spawnRuntime,
  stopRuntime,
} from "../../../packages/test-utils/src/runtimeProcess";
import { cloudFrontDownloadUrl } from "../src/cloudFrontDownloadUrl";
import { DYNAMODB_UPDATE_INDEX_NAME, dynamoDB } from "../src/dynamoDB";
import { s3Storage } from "../src/s3Storage";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");
const REGION = "us-east-1";
const ACCESS_KEY_ID = "test";
const SECRET_ACCESS_KEY = "test";
const PUBLIC_BASE_URL = "https://updates.example.com";
const S3_BUCKET_NAME = `hot-updater-aws-${process.pid}-${Date.now()}`
  .toLowerCase()
  .slice(0, 63);
const SSM_PARAMETER_NAME = `/hot-updater/aws/${process.pid}/${Date.now()}`;
const DYNAMODB_TABLE_NAME = `hot-updater-aws-${process.pid}-${Date.now()}`;
const CLOUDFRONT_KEY_PAIR_ID = "KTEST";
const LOCALSTACK_IMAGE = "localstack/localstack:3";
const LAMBDA_IMAGE = "public.ecr.aws/lambda/nodejs:22";
const ORIGIN_HOST = `${S3_BUCKET_NAME}.s3.${REGION}.amazonaws.com`;
const REQUIRED_BUILD_ARTIFACTS = [
  {
    command: "pnpm --filter @hot-updater/aws build",
    path: path.join(WORKSPACE_ROOT, "plugins/aws/dist/lambda/index.cjs"),
  },
] as const;

assertDockerDaemonAvailable(
  "aws lambda runtime acceptance requires a running Docker daemon.",
);

const ensureBuiltArtifacts = async (
  artifacts: ReadonlyArray<{ command: string; path: string }>,
) => {
  for (const artifact of artifacts) {
    try {
      await access(artifact.path);
    } catch {
      throw new Error(
        `Missing built artifact at ${artifact.path}. Run \`${artifact.command}\` before running this test.`,
      );
    }
  }
};

const toCloudFrontHeaders = (headers: Headers) => {
  const cloudFrontHeaders: Record<string, { key: string; value: string }[]> =
    {};

  for (const [key, value] of headers.entries()) {
    cloudFrontHeaders[key.toLowerCase()] = [{ key: key.toLowerCase(), value }];
  }

  return cloudFrontHeaders;
};

const createCloudFrontEvent = ({
  path: requestPath,
  headers,
  method = "GET",
  querystring = "",
  body,
}: {
  path: string;
  headers: Headers;
  method?: string;
  querystring?: string;
  body?: string;
}) => {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("host")) {
    requestHeaders.set("host", ORIGIN_HOST);
  }

  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: new URL(PUBLIC_BASE_URL).host,
            distributionId: "dist-id",
            eventType: "origin-request",
            requestId: "request-id",
          },
          request: {
            clientIp: "127.0.0.1",
            headers: toCloudFrontHeaders(requestHeaders),
            body:
              body === undefined
                ? undefined
                : {
                    action: "read-only",
                    data: Buffer.from(body).toString("base64"),
                    encoding: "base64",
                    inputTruncated: false,
                  },
            method,
            origin: {
              custom: {
                customHeaders: {},
                domainName: ORIGIN_HOST,
                keepaliveTimeout: 5,
                path: "",
                port: 443,
                protocol: "https",
                readTimeout: 30,
                sslProtocols: ["TLSv1.2"],
              },
            },
            querystring,
            uri: requestPath,
          },
        },
      },
    ],
  };
};

const invokeLambda = async (port: number, event: unknown) => {
  return await fetch(
    `http://127.0.0.1:${port}/2015-03-31/functions/function/invocations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    },
  );
};

const spawnLambdaRuntime = ({
  dockerNetworkName,
  lambdaPort,
  runtimeDir,
}: {
  dockerNetworkName: string;
  lambdaPort: number;
  runtimeDir: string;
}) =>
  spawnRuntime({
    command: "docker",
    args: [
      "run",
      "--rm",
      "--network",
      dockerNetworkName,
      "-p",
      `127.0.0.1:${lambdaPort}:8080`,
      "-v",
      `${runtimeDir}:/var/task`,
      "-v",
      `${WORKSPACE_ROOT}:${WORKSPACE_ROOT}:ro`,
      "-e",
      `AWS_REGION=${REGION}`,
      "-e",
      `AWS_ACCESS_KEY_ID=${ACCESS_KEY_ID}`,
      "-e",
      `AWS_SECRET_ACCESS_KEY=${SECRET_ACCESS_KEY}`,
      "-e",
      "AWS_ENDPOINT_URL=http://localstack:4566",
      LAMBDA_IMAGE,
      "index.handler",
    ],
    cwd: WORKSPACE_ROOT,
  });

const readLambdaJson = async (payload: {
  body?: string;
  headers?: Record<string, { key: string; value: string }[]>;
}) => {
  if (!payload.body) {
    return null;
  }

  return JSON.parse(payload.body) as Record<string, unknown> | null;
};

const toRuntimeBundle = (bundle: Bundle): Bundle => {
  return {
    ...bundle,
    storageUri: `s3://${S3_BUCKET_NAME}/bundles/${bundle.id}/bundle.zip`,
  };
};

const seedProductionRelease = async ({
  bundle,
  database,
}: {
  readonly bundle: Bundle;
  readonly database: ReturnType<typeof dynamoDB>;
}) => {
  const channelName = "production";
  const channelKey = encodeChannelKey(channelName);
  const channel = (
    await database.models.channels.insert({
      row: { id: `channel:${channelKey}`, name: channelName },
      onConflict: "returnExisting",
    })
  ).row;
  const scopeKey = createReleaseCatalogScopeKey({
    channelKey,
    platform: bundle.platform,
    strategy: "APP_VERSION",
  });
  const now = Date.now();
  await commitReleaseCatalogMutations({
    database,
    mutations: [
      {
        mutation: {
          operation: "insert",
          row: {
            bundle_id: bundle.id,
            channel_id: channel.id,
            created_at_ms: now,
            enabled: true,
            fingerprint_hash: null,
            id: createUUIDv7(),
            kind: "BUNDLE",
            message: "hello",
            operation: "DEPLOY",
            platform: bundle.platform,
            revision: 1,
            rollout_cohort_count: 1_000,
            scope_key: scopeKey,
            should_force_update: false,
            source_release_id: null,
            strategy: "APP_VERSION",
            target_app_version: "1.0",
            target_cohorts: [],
            updated_at_ms: now,
          },
        },
        scope: {
          channelId: channel.id,
          channelName,
          fingerprintHash: null,
          platform: bundle.platform,
          scopeKey,
          strategy: "APP_VERSION",
        },
        updatedAtMs: now,
      },
    ],
  });
};

describe.sequential("aws lambda runtime acceptance", () => {
  let localstackPort = 0;
  let lambdaPort = 0;
  let localstackRuntime: ReturnType<typeof spawnRuntime> | undefined;
  let lambdaRuntime: ReturnType<typeof spawnRuntime> | undefined;
  let runtimeDir: string | undefined;
  let localstackEndpoint = "";
  let database: ReturnType<typeof dynamoDB>;
  let rawApiKey = "";
  let seedHotUpdater: ReturnType<typeof createHotUpdater>;
  let s3Client: S3Client;
  let dynamodbClient: DynamoDBDocumentClient;
  let previousAwsEndpointUrl: string | undefined;
  const dockerNetworkName = `hot-updater-aws-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    await ensureBuiltArtifacts(REQUIRED_BUILD_ARTIFACTS);

    previousAwsEndpointUrl = process.env.AWS_ENDPOINT_URL;

    runCheckedCommand({
      command: "docker",
      args: ["network", "create", dockerNetworkName],
      cwd: WORKSPACE_ROOT,
    });

    localstackPort = await findOpenPort();
    localstackEndpoint = `http://127.0.0.1:${localstackPort}`;
    localstackRuntime = spawnRuntime({
      command: "docker",
      args: [
        "run",
        "--rm",
        "--name",
        `hot-updater-localstack-${process.pid}`,
        "--network",
        dockerNetworkName,
        "--network-alias",
        "localstack",
        "-p",
        `127.0.0.1:${localstackPort}:4566`,
        "-e",
        "SERVICES=dynamodb,s3,ssm",
        "-e",
        `DEFAULT_REGION=${REGION}`,
        "-e",
        `AWS_ACCESS_KEY_ID=${ACCESS_KEY_ID}`,
        "-e",
        `AWS_SECRET_ACCESS_KEY=${SECRET_ACCESS_KEY}`,
        LOCALSTACK_IMAGE,
      ],
      cwd: WORKSPACE_ROOT,
    });

    await waitForLocalstackReady({
      client: createHostS3Client(localstackEndpoint),
      child: localstackRuntime.child,
      logs: localstackRuntime.logs,
    });

    s3Client = createHostS3Client(localstackEndpoint);

    await ensureBucketExists(s3Client, S3_BUCKET_NAME);
    await createPrivateKeyParameter(localstackEndpoint);
    await createDynamoDBTable(localstackEndpoint);
    dynamodbClient = DynamoDBDocumentClient.from(
      createHostDynamoDBClient(localstackEndpoint),
    );
    process.env.AWS_ENDPOINT_URL = localstackEndpoint;

    database = dynamoDB({
      tableName: DYNAMODB_TABLE_NAME,
      region: REGION,
      endpoint: localstackEndpoint,
      credentials: {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      },
    });
    seedHotUpdater = createHotUpdater({
      database,
      clientAccess: { type: "api-key" },
      storage: [
        s3Storage({
          bucketName: S3_BUCKET_NAME,
          region: REGION,
          endpoint: localstackEndpoint,
          forcePathStyle: true,
          credentials: {
            accessKeyId: ACCESS_KEY_ID,
            secretAccessKey: SECRET_ACCESS_KEY,
          },
          getDownloadUrl: cloudFrontDownloadUrl({
            keyPairId: CLOUDFRONT_KEY_PAIR_ID,
            ssmRegion: REGION,
            ssmParameterName: SSM_PARAMETER_NAME,
            publicBaseUrl: PUBLIC_BASE_URL,
          }),
        }),
      ],
    });

    runtimeDir = await mkdtemp(
      path.join(WORKSPACE_ROOT, "plugins/aws/runtime-acceptance-"),
    );
    const lambdaDistDir = path.join(WORKSPACE_ROOT, "plugins/aws/dist/lambda");
    await cp(lambdaDistDir, runtimeDir, { recursive: true });

    const transformedCode = transformEnv(path.join(runtimeDir, "index.cjs"), {
      CLOUDFRONT_KEY_PAIR_ID,
      DYNAMODB_REGION: REGION,
      DYNAMODB_TABLE_NAME,
      SSM_PARAMETER_NAME,
      SSM_REGION: REGION,
      S3_BUCKET_NAME,
    });
    await writeFile(path.join(runtimeDir, "index.cjs"), transformedCode);

    lambdaPort = await findOpenPort();
    lambdaRuntime = spawnLambdaRuntime({
      dockerNetworkName,
      lambdaPort,
      runtimeDir,
    });

    await waitForLambdaReady({
      port: lambdaPort,
      child: lambdaRuntime.child,
      logs: lambdaRuntime.logs,
    });
  }, 180_000);

  beforeEach(async () => {
    await Promise.all([
      clearBucket(s3Client, S3_BUCKET_NAME),
      clearDynamoDBTable(dynamodbClient),
    ]);
    const created = await createApiKey({
      apiKeys: database.models.apiKeys,
      name: "Runtime test",
    });
    rawApiKey = created.apiKey;
  });

  afterAll(async () => {
    dynamodbClient?.destroy();
    if (lambdaRuntime) {
      await stopRuntime(lambdaRuntime.child);
    }

    if (localstackRuntime) {
      await stopRuntime(localstackRuntime.child);
    }

    try {
      runCheckedCommand({
        command: "docker",
        args: ["network", "rm", dockerNetworkName],
        cwd: WORKSPACE_ROOT,
      });
    } catch {
      // ignore network cleanup failures
    }

    if (runtimeDir) {
      await rm(runtimeDir, { recursive: true, force: true });
    }

    if (previousAwsEndpointUrl === undefined) {
      delete process.env.AWS_ENDPOINT_URL;
    } else {
      process.env.AWS_ENDPOINT_URL = previousAwsEndpointUrl;
    }
  });

  it("serves unversioned Release Catalog routes from the packaged lambda entrypoint", async () => {
    const bundle = toRuntimeBundle({
      id: "00000000-0000-0000-0000-000000000001",
      platform: "ios",
      fileHash: "hash",
      gitCommitHash: null,
      storageUri: "storage://unused",
      archiveByteSize: 3_000_000_001,
    });
    await seedHotUpdater.insertBundle(bundle);
    await seedProductionRelease({ bundle, database });

    const updatePath = "/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.0.0";
    const unauthorizedResponse = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: updatePath,
        headers: new Headers(),
      }),
    );
    const unauthorizedPayload = (await unauthorizedResponse.json()) as {
      status?: string;
    };
    const response = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: updatePath,
        headers: new Headers({ "x-api-key": rawApiKey }),
      }),
    );
    const payload = (await response.json()) as {
      body?: string;
      headers?: Record<string, { key: string; value: string }[]>;
    };

    expect(unauthorizedPayload.status).toBe("401");
    const body = (await readLambdaJson(payload)) as {
      catalogId?: string;
      releases?: { bundleId?: string }[];
    };

    expect(body).toMatchObject({
      catalogId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      releases: [{ bundleId: "00000000-0000-0000-0000-000000000001" }],
    });
  });

  it("does not support the legacy exact path", async () => {
    const response = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: "/api/check-update",
        headers: new Headers(),
      }),
    );
    const payload = (await response.json()) as {
      body?: string;
      headers?: Record<string, { key: string; value: string }[]>;
      status?: string;
    };

    expect(payload.status).toBe("404");
  });

  it("does not expose management routes from the packaged lambda entrypoint", async () => {
    const response = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: "/admin/bundles",
        headers: new Headers(),
      }),
    );
    const payload = (await response.json()) as {
      body?: string;
    };

    await expect(readLambdaJson(payload)).resolves.toEqual({
      error: "Not found",
    });
  });

  it("accepts authenticated events through the built-in domains", async () => {
    const event = {
      type: "UNCHANGED",
      installId: "aws-runtime-installation",
      toBundleId: "00000000-0000-0000-0000-000000000001",
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "default",
      fingerprintHash: null,
      fromBundleId: null,
      fromReleaseId: null,
      toReleaseId: null,
      updateStrategy: null,
    };
    const unauthorizedIngestionResponse = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: "/events",
        headers: new Headers({ "content-type": "application/json" }),
        method: "POST",
        body: JSON.stringify(event),
      }),
    );
    const unauthorizedIngestionPayload =
      (await unauthorizedIngestionResponse.json()) as { status?: string };
    const ingestionResponse = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: "/events",
        headers: new Headers({
          "content-type": "application/json",
          "x-api-key": rawApiKey,
        }),
        method: "POST",
        body: JSON.stringify(event),
      }),
    );
    const ingestionPayload = (await ingestionResponse.json()) as {
      status?: string;
    };

    expect(unauthorizedIngestionPayload.status).toBe("401");
    expect(ingestionPayload.status).toBe("204");

    const protectedPath = "/admin/installations/overview";
    const unauthorizedResponse = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: protectedPath,
        headers: new Headers(),
      }),
    );
    const unauthorizedPayload = (await unauthorizedResponse.json()) as {
      status?: string;
    };

    expect(unauthorizedPayload.status).toBe("404");

    const authorizedResponse = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: protectedPath,
        headers: new Headers({ "x-api-key": rawApiKey }),
      }),
    );
    const authorizedPayload = (await authorizedResponse.json()) as {
      body?: string;
      status?: string;
    };

    expect(authorizedPayload.status).toBe("404");
    await expect(readLambdaJson(authorizedPayload)).resolves.toEqual({
      error: "Not found",
    });

    await expect(
      database.models.analytics.scan({
        beforeReceivedAtMs: Date.now() + 1_000,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        install_id: "aws-runtime-installation",
        type: "UNCHANGED",
      }),
    ]);
  });
});

const createHostS3Client = (endpoint: string) => {
  return new S3Client({
    region: REGION,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  });
};

const createHostDynamoDBClient = (endpoint: string) =>
  new DynamoDBClient({
    region: REGION,
    endpoint,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  });

const createDynamoDBTable = async (endpoint: string) => {
  const client = createHostDynamoDBClient(endpoint);
  await client.send(
    new CreateTableCommand({
      TableName: DYNAMODB_TABLE_NAME,
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
    { TableName: DYNAMODB_TABLE_NAME },
  );
  client.destroy();
};

const clearDynamoDBTable = async (client: DynamoDBDocumentClient) => {
  const { Items = [] } = await client.send(
    new ScanCommand({
      TableName: DYNAMODB_TABLE_NAME,
      ProjectionExpression: "#pk, #sk",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    }),
  );
  const keys = Items.map(({ pk, sk }) => ({ pk, sk }));
  for (let offset = 0; offset < keys.length; offset += 25) {
    await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [DYNAMODB_TABLE_NAME]: keys
            .slice(offset, offset + 25)
            .map((Key) => ({ DeleteRequest: { Key } })),
        },
      }),
    );
  }
};

const waitForLocalstackReady = async ({
  client,
  child,
  logs,
  timeoutMs = 90_000,
}: {
  client: S3Client;
  child: ReturnType<typeof spawnRuntime>["child"];
  logs: ReturnType<typeof spawnRuntime>["logs"];
  timeoutMs?: number;
}) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`localstack exited early: ${formatRuntimeLogs(logs)}`);
    }

    try {
      await client.send(new ListBucketsCommand({}));
      return;
    } catch {
      await sleep(500);
    }
  }

  throw new Error(
    `localstack did not become ready: ${formatRuntimeLogs(logs)}`,
  );
};

const waitForLambdaReady = async ({
  port,
  child,
  logs,
  timeoutMs = 90_000,
}: {
  port: number;
  child: ReturnType<typeof spawnRuntime>["child"];
  logs: ReturnType<typeof spawnRuntime>["logs"];
  timeoutMs?: number;
}) => {
  const deadline = Date.now() + timeoutMs;
  const warmupEvent = createCloudFrontEvent({
    path: "/version",
    headers: new Headers({
      "x-app-platform": "ios",
      "x-app-version": "1.0.0",
    }),
  });

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`lambda exited early: ${formatRuntimeLogs(logs)}`);
    }

    try {
      const response = await invokeLambda(port, warmupEvent);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }

    await sleep(500);
  }

  throw new Error(`lambda did not become ready: ${formatRuntimeLogs(logs)}`);
};

const ensureBucketExists = async (client: S3Client, bucketName: string) => {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucketName }));
  }
};

const clearBucket = async (client: S3Client, bucketName: string) => {
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
      }),
    );

    const objects = (response.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => Boolean(key))
      .map((Key) => ({ Key }));

    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: objects,
            Quiet: true,
          },
        }),
      );
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
};

const createPrivateKeyParameter = async (endpoint: string) => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs1",
      format: "pem",
    },
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
  });

  const client = new SSMClient({
    region: REGION,
    endpoint,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
  });

  await client.send(
    new PutParameterCommand({
      Name: SSM_PARAMETER_NAME,
      Type: "SecureString",
      Value: JSON.stringify({
        privateKey,
      }),
      Overwrite: true,
    }),
  );
};

const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};
