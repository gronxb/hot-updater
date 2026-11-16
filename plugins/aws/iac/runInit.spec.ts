import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBucket: vi.fn(),
  createOrSelectRole: vi.fn(),
  createOrUpdateDistribution: vi.fn(),
  deploy: vi.fn(),
  dispose: vi.fn(),
  ensureTable: vi.fn(),
  getOrCreateKeyGroup: vi.fn(),
  getOrCreateKeyPair: vi.fn(),
  listBuckets: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  makeEnv: vi.fn(),
  migrateDynamoDB: vi.fn(),
  printAppSetup: vi.fn(),
  provisionClientCredential: vi.fn(),
  selectDistribution: vi.fn(),
  updateBucketPolicy: vi.fn(),
  waitForDeployed: vi.fn(),
  writeHotUpdaterFiles: vi.fn(),
  /** The table every dynamoDB(...) of a run opens: one store, as on AWS. */
  table: { adapter: undefined as unknown },
}));

vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ stdout: "aws-cli/2.0.0" })),
}));

vi.mock("./awsAuth", () => ({
  resolveAwsAuth: vi.fn(async () => ({
    awsProfile: null,
    configAuthMode: { mode: "account" },
    credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
    mode: "account",
  })),
}));

vi.mock("./s3", () => ({
  S3Manager: vi.fn(function S3Manager() {
    return {
      createBucket: mocks.createBucket,
      listBuckets: mocks.listBuckets,
      updateBucketPolicy: mocks.updateBucketPolicy,
    };
  }),
}));

vi.mock("./dynamodb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dynamodb")>()),
  DynamoDBManager: vi.fn(function DynamoDBManager() {
    return { ensureTable: mocks.ensureTable };
  }),
}));

vi.mock("../src/dynamoDB", async () => {
  const { createMemoryAdapter } = await vi.importActual<
    typeof import("@hot-updater/plugin-core")
  >("@hot-updater/plugin-core");
  return {
    dynamoDB: vi.fn(() => ({
      name: "dynamoDB",
      adapter: (mocks.table.adapter ??= createMemoryAdapter()),
      dispose: mocks.dispose,
    })),
    migrateDynamoDB: mocks.migrateDynamoDB,
  };
});

vi.mock("./iam", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./iam")>()),
  IAMManager: vi.fn(function IAMManager() {
    return { createOrSelectRole: mocks.createOrSelectRole };
  }),
}));

vi.mock("./ssm", () => ({
  SSMKeyPairManager: vi.fn(function SSMKeyPairManager() {
    return { getOrCreateKeyPair: mocks.getOrCreateKeyPair };
  }),
}));

vi.mock("./cloudfront", () => ({
  CloudFrontManager: vi.fn(function CloudFrontManager() {
    return {
      createOrUpdateDistribution: mocks.createOrUpdateDistribution,
      getOrCreateKeyGroup: mocks.getOrCreateKeyGroup,
      selectDistribution: mocks.selectDistribution,
      waitForDeployed: mocks.waitForDeployed,
    };
  }),
}));

vi.mock("./awsInfrastructureState", () => ({
  assertAwsInfrastructureGeneration: vi.fn(),
  assertAwsLambdaCanInitialize: vi.fn(),
}));

vi.mock("./lambdaEdge", () => ({
  LambdaEdgeDeployer: vi.fn(function LambdaEdgeDeployer() {
    return { deploy: mocks.deploy };
  }),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    // The managed server's plugins, over the mocked database.
    provisionClientCredential: mocks.provisionClientCredential,
    confirmInitInputPersistence: vi.fn(async () => false),
    ensureInstallPackages: vi.fn(),
    makeEnv: mocks.makeEnv,
    printAppSetup: mocks.printAppSetup,
    p: { ...actual.p, log: mocks.log },
    readHotUpdaterInitEnv: vi.fn(async () => ({
      env: SAVED_ENV,
      managedEnv: {},
    })),
    writeHotUpdaterFiles: mocks.writeHotUpdaterFiles,
  };
});

import {
  createEngineDatabase,
  createMemoryAdapter,
  type DatabaseAdapter,
  migrateCoreSchema,
  SETTINGS_TABLE,
} from "@hot-updater/plugin-core";
import {
  createHotUpdater,
  HOT_UPDATER_SERVER_VERSION,
} from "@hot-updater/server";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";

import { getAwsV1SsmParameterName } from "./awsInfrastructureNames";
import { runInit } from "./index";
import { getConfigScaffold } from "./templates";

/** What a previous init saved, which a replay reads. */
const SAVED_ENV = {
  HOT_UPDATER_AWS_AUTH_MODE: "account",
  HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
  HOT_UPDATER_DYNAMODB_TABLE_NAME: "hot-updater-metadata",
  HOT_UPDATER_S3_ACCESS_KEY_ID: "AKIATEST",
  HOT_UPDATER_S3_BUCKET_NAME: "bundles",
  HOT_UPDATER_S3_REGION: "ap-northeast-2",
  HOT_UPDATER_S3_SECRET_ACCESS_KEY: "secret",
};

const FUNCTION_ARN =
  "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge:3";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listBuckets.mockResolvedValue([
    { name: "bundles", region: "ap-northeast-2" },
  ]);
  mocks.selectDistribution.mockResolvedValue({
    DomainName: "d111111abcdef8.cloudfront.net",
    Id: "dist-id",
  });
  mocks.createOrSelectRole.mockResolvedValue(
    "arn:aws:iam::123456789012:role/hot-updater-edge",
  );
  mocks.getOrCreateKeyPair.mockResolvedValue({ publicKey: "public-key" });
  mocks.getOrCreateKeyGroup.mockResolvedValue({
    keyGroupId: "key-group-id",
    publicKeyId: "public-key-id",
  });
  mocks.deploy.mockImplementation(async (_role, lambdaName) => ({
    functionArn: FUNCTION_ARN,
    lambdaName,
  }));
  mocks.createOrUpdateDistribution.mockResolvedValue({
    distributionDomain: "d111111abcdef8.cloudfront.net",
    distributionId: "dist-id",
  });
  mocks.provisionClientCredential.mockResolvedValue(undefined);
  mocks.table.adapter = undefined;
  mocks.waitForDeployed.mockResolvedValue(true);
  vi.unstubAllGlobals();
});

/**
 * The deployed function over the run's table, behind the CloudFront domain:
 * `/version` answers `version`, and the partitioning route is the server's.
 */
const deployedFunction = async (version = HOT_UPDATER_SERVER_VERSION) => {
  const adapter = createMemoryAdapter();
  await migrateCoreSchema(adapter, "dynamoDB");
  mocks.table.adapter = adapter;
  const server = createHotUpdater({
    clientAccess: "public",
    database: createEngineDatabase({ name: "dynamoDB", adapter }),
    storage: createReleaseCatalogTestStorage(),
  });
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
      if (url.pathname === "/version") return Response.json({ version });
      return server.handlers.client(new Request(url, init));
    },
  );
  return {
    requests,
    switchValue: async () =>
      (
        await (adapter as DatabaseAdapter).get(SETTINGS_TABLE, [
          ["catalog.partitioning"],
        ])
      )[0]?.["value"] ?? null,
  };
};

describe("AWS init", () => {
  it("deploys the prebuilt function, with its plugins' tables, the app's credential, and CloudFront's client headers", async () => {
    const result = await runInit({ build: "bare", envFile: ".env.hotupdater" });

    // Init's closing prints the next steps and Done, after every step.
    expect(result).toEqual({
      nextSteps: [
        expect.stringContaining(
          "hot-updater.dev/docs/managed/aws#step-3-add-hotupdater-to-your-project",
        ),
      ],
    });
    expect(mocks.log.success).not.toHaveBeenCalledWith("Done! 🎉");

    const ssmParameterName = getAwsV1SsmParameterName("hot-updater-edge");
    expect(mocks.migrateDynamoDB).toHaveBeenCalledWith(
      {
        credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
        region: "ap-northeast-2",
        tableName: "hot-updater-metadata",
      },
      [
        expect.objectContaining({ id: "insights" }),
        expect.objectContaining({ id: "apiKeys" }),
        expect.objectContaining({ id: "remoteConfig" }),
      ],
    );
    // The managed server: its plugins on the table init set up.
    expect(mocks.provisionClientCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        database: expect.objectContaining({ name: "dynamoDB" }),
        plugins: [
          expect.objectContaining({ id: "insights" }),
          expect.objectContaining({ id: "apiKeys" }),
          expect.objectContaining({ id: "remoteConfig" }),
        ],
      }),
      { env: SAVED_ENV, name: "AWS init" },
    );
    expect(mocks.createOrSelectRole).toHaveBeenCalledWith({
      bucketName: "bundles",
      dynamodbTableName: "hot-updater-metadata",
      lambdaName: "hot-updater-edge",
      ssmParameterName,
    });
    expect(mocks.deploy).toHaveBeenCalledWith(
      "arn:aws:iam::123456789012:role/hot-updater-edge",
      "hot-updater-edge",
      {
        bucketName: "bundles",
        dynamodbRegion: "ap-northeast-2",
        dynamodbTableName: "hot-updater-metadata",
        publicKeyId: "public-key-id",
        ssmParameterName,
        ssmRegion: "ap-northeast-2",
      },
    );
    expect(mocks.createOrUpdateDistribution).toHaveBeenCalledWith({
      keyGroupId: "key-group-id",
      bucketName: "bundles",
      clientHeaders: ["x-api-key"],
      distribution: {
        DomainName: "d111111abcdef8.cloudfront.net",
        Id: "dist-id",
      },
      functionArn: FUNCTION_ARN,
    });
    expect(mocks.writeHotUpdaterFiles).toHaveBeenCalledWith(
      getConfigScaffold(
        "bare",
        { mode: "account" },
        {
          region: "ap-northeast-2",
          bucketName: "bundles",
          tableName: "hot-updater-metadata",
          cloudfrontDistributionId: "dist-id",
        },
      ),
      { cwd: process.cwd(), settings: "AWS" },
    );
    expect(mocks.printAppSetup).toHaveBeenCalledWith({
      baseURL: "https://d111111abcdef8.cloudfront.net",
      clientPlugins: [
        expect.objectContaining({ module: "@hot-updater/react-native" }),
      ],
    });
  });

  it("saves the app's credential, then closes the table's client", async () => {
    const credential = {
      label: "API key",
      header: "x-api-key",
      env: "HOT_UPDATER_API_KEY",
      value: "app-api-key",
    };
    mocks.provisionClientCredential.mockResolvedValue(credential);

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect(mocks.makeEnv).toHaveBeenCalledWith({
      HOT_UPDATER_API_KEY: "app-api-key",
    });
    // The credential's client, then the partitioning step's.
    expect(mocks.dispose).toHaveBeenCalledTimes(2);
    expect(mocks.dispose.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.provisionClientCredential.mock.invocationCallOrder[0]!,
    );
    expect(mocks.printAppSetup).toHaveBeenCalledWith(
      expect.objectContaining({ credential }),
    );
  });

  it("partitions release catalogs once CloudFront is Deployed and every /version is this release", async () => {
    const fn = await deployedFunction();
    await runInit({ build: "bare", envFile: ".env.hotupdater" });
    expect(mocks.waitForDeployed).toHaveBeenCalledWith("dist-id");
    expect(mocks.waitForDeployed.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.createOrUpdateDistribution.mock.invocationCallOrder[0]!,
    );
    expect(fn.requests.filter((r) => r.endsWith("/version"))).toHaveLength(5);
    expect(fn.requests.at(-1)).toBe(
      "POST d111111abcdef8.cloudfront.net/release-catalog-partitioning",
    );
    expect(await fn.switchValue()).toBe("on");
    expect(mocks.log.success).toHaveBeenCalledWith(
      "Release catalogs are partitioned.",
    );

    // Replayed after the migration, on the partitioned table: on, unchanged,
    // with nothing to wait for.
    mocks.waitForDeployed.mockClear();
    fn.requests.length = 0;
    await runInit({ build: "bare", envFile: ".env.hotupdater" });
    expect(mocks.waitForDeployed).not.toHaveBeenCalled();
    expect(fn.requests).toEqual([]);
  });

  it.each([
    [
      "CloudFront is not Deployed in time",
      () => {
        mocks.waitForDeployed.mockResolvedValue(
          "CloudFront distribution dist-id is still InProgress after 30 minutes.",
        );
      },
      "CloudFront distribution dist-id is still InProgress after 30 minutes.",
    ],
    [
      "an edge still answers the old /version",
      () => {},
      `https://d111111abcdef8.cloudfront.net/version answered 1.1.16, not ${HOT_UPDATER_SERVER_VERSION}.`,
    ],
  ] as const)(
    "leaves partitioning off when %s, and prints the command",
    async (name, arrange, reason) => {
      const fn = await deployedFunction(
        name.includes("old") ? "1.1.16" : HOT_UPDATER_SERVER_VERSION,
      );
      arrange();
      await runInit({ build: "bare", envFile: ".env.hotupdater" });
      expect(await fn.switchValue()).toBeNull();
      expect(mocks.log.warn).toHaveBeenCalledWith(
        `Release catalogs stay single-row: ${reason}\nOnce every server runs 1.2.0, partition them:\nnpx hot-updater db partition-catalogs --server-url https://d111111abcdef8.cloudfront.net`,
      );
    },
  );
});
