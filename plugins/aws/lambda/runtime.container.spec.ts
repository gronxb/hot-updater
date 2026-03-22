import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { transformEnv } from "@hot-updater/cli-tools";
import { type Bundle, type GetBundlesArgs, NIL_UUID } from "@hot-updater/core";
import { createHotUpdater } from "@hot-updater/server/runtime";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  findOpenPort,
  formatRuntimeLogs,
  hasCommand,
  runCheckedCommand,
  spawnRuntime,
  stopRuntime,
} from "../../../packages/test-utils/src/runtimeProcess";
import { s3Database } from "../src/s3Database";
import { s3LambdaEdgeStorage } from "../src/s3LambdaEdgeStorage";
import {
  NO_STORE_CACHE_CONTROL,
  SHARED_EDGE_CACHE_CONTROL,
} from "./cacheControl";
import { HOT_UPDATER_BASE_PATH } from "./runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "../../..");
const BUILD_FILTER = "@hot-updater/aws";
const REGION = "us-east-1";
const ACCESS_KEY_ID = "test";
const SECRET_ACCESS_KEY = "test";
const PUBLIC_BASE_URL = "https://updates.example.com";
const S3_BUCKET_NAME = `hot-updater-aws-${process.pid}-${Date.now()}`
  .toLowerCase()
  .slice(0, 63);
const SSM_PARAMETER_NAME = `/hot-updater/aws/${process.pid}/${Date.now()}`;
const CLOUDFRONT_KEY_PAIR_ID = "KTEST";
const LOCALSTACK_IMAGE = "localstack/localstack:3";
const LAMBDA_IMAGE = "public.ecr.aws/lambda/nodejs:22";
const hasDocker = hasCommand("docker", [
  "version",
  "--format",
  "{{.Server.Version}}",
]);
const describeIfDocker = hasDocker ? describe.sequential : describe.skip;

const createLegacyHeaders = (args: GetBundlesArgs) => {
  const headers = new Headers({
    host: new URL(PUBLIC_BASE_URL).host,
    "x-app-platform": args.platform,
    "x-bundle-id": args.bundleId,
  });

  if (args.channel) {
    headers.set("x-channel", args.channel);
  }

  if (args.minBundleId) {
    headers.set("x-min-bundle-id", args.minBundleId);
  }

  if (args.cohort) {
    headers.set("x-cohort", args.cohort);
  }

  if (args._updateStrategy === "appVersion") {
    headers.set("x-app-version", args.appVersion);
  } else {
    headers.set("x-fingerprint-hash", args.fingerprintHash);
  }

  return headers;
};

const createCanonicalPath = (args: GetBundlesArgs) => {
  const channel = args.channel ?? "production";
  const minBundleId = args.minBundleId ?? NIL_UUID;
  const cohortSegment = args.cohort
    ? `/${encodeURIComponent(args.cohort)}`
    : "";

  if (args._updateStrategy === "appVersion") {
    return `${HOT_UPDATER_BASE_PATH}/app-version/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.appVersion)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`;
  }

  return `${HOT_UPDATER_BASE_PATH}/fingerprint/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.fingerprintHash)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`;
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
}: {
  path: string;
  headers: Headers;
}) => {
  return {
    Records: [
      {
        cf: {
          config: {
            distributionDomainName: new URL(PUBLIC_BASE_URL).host,
            distributionId: "dist-id",
            eventType: "viewer-request",
            requestId: "request-id",
          },
          request: {
            clientIp: "127.0.0.1",
            headers: toCloudFrontHeaders(headers),
            method: "GET",
            querystring: "",
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

describeIfDocker("aws lambda runtime acceptance", () => {
  let localstackPort = 0;
  let lambdaPort = 0;
  let localstackRuntime: ReturnType<typeof spawnRuntime> | undefined;
  let lambdaRuntime: ReturnType<typeof spawnRuntime> | undefined;
  let runtimeDir: string | undefined;
  let localstackEndpoint = "";
  let seedHotUpdater: ReturnType<typeof createHotUpdater>;
  let s3Client: S3Client;
  let previousAwsEndpointUrl: string | undefined;
  const dockerNetworkName = `hot-updater-aws-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    runCheckedCommand({
      command: "pnpm",
      args: ["--filter", BUILD_FILTER, "build"],
      cwd: WORKSPACE_ROOT,
    });

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
        "SERVICES=s3,ssm",
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

    process.env.AWS_ENDPOINT_URL = localstackEndpoint;

    seedHotUpdater = createHotUpdater({
      database: s3Database({
        bucketName: S3_BUCKET_NAME,
        region: REGION,
        endpoint: localstackEndpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
        },
      }),
      storages: [
        s3LambdaEdgeStorage({
          bucketName: S3_BUCKET_NAME,
          region: REGION,
          endpoint: localstackEndpoint,
          forcePathStyle: true,
          credentials: {
            accessKeyId: ACCESS_KEY_ID,
            secretAccessKey: SECRET_ACCESS_KEY,
          },
          keyPairId: CLOUDFRONT_KEY_PAIR_ID,
          ssmRegion: REGION,
          ssmParameterName: SSM_PARAMETER_NAME,
          publicBaseUrl: PUBLIC_BASE_URL,
        }),
      ],
      basePath: HOT_UPDATER_BASE_PATH,
      routes: {
        updateCheck: true,
        bundles: false,
      },
    });

    runtimeDir = await mkdtemp(
      path.join(WORKSPACE_ROOT, "plugins/aws/runtime-acceptance-"),
    );
    await symlink(
      path.join(WORKSPACE_ROOT, "plugins/aws/node_modules"),
      path.join(runtimeDir, "node_modules"),
    );

    const transformedCode = transformEnv(
      path.join(WORKSPACE_ROOT, "plugins/aws/dist/lambda/index.cjs"),
      {
        CLOUDFRONT_KEY_PAIR_ID,
        SSM_PARAMETER_NAME,
        SSM_REGION: REGION,
        S3_BUCKET_NAME,
      },
    );
    await writeFile(path.join(runtimeDir, "index.cjs"), transformedCode);

    lambdaPort = await findOpenPort();
    lambdaRuntime = spawnRuntime({
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

    await waitForLambdaReady({
      port: lambdaPort,
      child: lambdaRuntime.child,
      logs: lambdaRuntime.logs,
    });
  }, 180_000);

  beforeEach(async () => {
    await clearBucket(s3Client, S3_BUCKET_NAME);
  });

  afterAll(async () => {
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

  const getUpdateInfo = async (bundles: Bundle[], args: GetBundlesArgs) => {
    for (const bundle of bundles.map(toRuntimeBundle)) {
      await seedHotUpdater.insertBundle(bundle);
    }

    const response = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: HOT_UPDATER_BASE_PATH,
        headers: createLegacyHeaders(args),
      }),
    );
    expect(response.ok).toBe(true);

    const payload = (await response.json()) as {
      body?: string;
      headers?: Record<string, { key: string; value: string }[]>;
    };

    return (await readLambdaJson(payload)) as any;
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });

  it("serves canonical routes from the packaged lambda entrypoint", async () => {
    await seedHotUpdater.insertBundle(
      toRuntimeBundle({
        id: "00000000-0000-0000-0000-000000000001",
        platform: "ios",
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash",
        gitCommitHash: null,
        message: "hello",
        channel: "production",
        storageUri: "storage://unused",
        fingerprintHash: null,
      }),
    );

    const response = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: createCanonicalPath({
          appVersion: "1.0",
          bundleId: NIL_UUID,
          platform: "ios",
          _updateStrategy: "appVersion",
        }),
        headers: new Headers({
          host: new URL(PUBLIC_BASE_URL).host,
        }),
      }),
    );
    const payload = (await response.json()) as {
      body?: string;
      headers?: Record<string, { key: string; value: string }[]>;
    };

    expect(payload.headers?.["cache-control"]?.[0]?.value).toBe(
      SHARED_EDGE_CACHE_CONTROL,
    );
    await expect(readLambdaJson(payload)).resolves.toMatchObject({
      id: "00000000-0000-0000-0000-000000000001",
      status: "UPDATE",
    });
  });

  it("marks legacy exact responses as non-cacheable in the packaged lambda entrypoint", async () => {
    const response = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: HOT_UPDATER_BASE_PATH,
        headers: new Headers({
          host: new URL(PUBLIC_BASE_URL).host,
          "x-app-platform": "ios",
          "x-app-version": "1.0.0",
        }),
      }),
    );
    const payload = (await response.json()) as {
      body?: string;
      headers?: Record<string, { key: string; value: string }[]>;
    };

    expect(payload.headers?.["cache-control"]?.[0]?.value).toBe(
      NO_STORE_CACHE_CONTROL,
    );
    await expect(readLambdaJson(payload)).resolves.toEqual({
      error: "Missing required headers (x-app-platform, x-bundle-id).",
    });
  });

  it("does not expose management routes from the packaged lambda entrypoint", async () => {
    const response = await invokeLambda(
      lambdaPort,
      createCloudFrontEvent({
        path: `${HOT_UPDATER_BASE_PATH}/api/bundles`,
        headers: new Headers({
          host: new URL(PUBLIC_BASE_URL).host,
        }),
      }),
    );
    const payload = (await response.json()) as {
      body?: string;
    };

    await expect(readLambdaJson(payload)).resolves.toEqual({
      error: "Not found",
    });
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
    path: HOT_UPDATER_BASE_PATH,
    headers: new Headers({
      host: new URL(PUBLIC_BASE_URL).host,
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
