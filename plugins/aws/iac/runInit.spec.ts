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
  writeHotUpdaterFiles: vi.fn(),
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
      adapter: createMemoryAdapter(),
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

import { plugins } from "../src/plugins";
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
});

describe("AWS init", () => {
  it("deploys the prebuilt function, with the package's plugins' tables, the app's credential, and CloudFront's client headers", async () => {
    await runInit({
      build: {
        imports: [{ pkg: "@hot-updater/bare", named: ["bare"] }],
        configString: "bare({ enableHermes: true })",
      },
      envFile: ".env.hotupdater",
    });

    const ssmParameterName = getAwsV1SsmParameterName("hot-updater-edge");
    expect(mocks.migrateDynamoDB).toHaveBeenCalledWith(
      {
        credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
        region: "ap-northeast-2",
        tableName: "hot-updater-metadata",
      },
      plugins,
    );
    // The managed server: the package's plugins on the table init set up.
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
        {
          imports: [{ pkg: "@hot-updater/bare", named: ["bare"] }],
          configString: "bare({ enableHermes: true })",
        },
        { mode: "account" },
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

    await runInit({
      build: {
        imports: [{ pkg: "@hot-updater/bare", named: ["bare"] }],
        configString: "bare({ enableHermes: true })",
      },
      envFile: ".env.hotupdater",
    });

    expect(mocks.makeEnv).toHaveBeenCalledWith({
      HOT_UPDATER_API_KEY: "app-api-key",
    });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.dispose.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.provisionClientCredential.mock.invocationCallOrder[0]!,
    );
    expect(mocks.printAppSetup).toHaveBeenCalledWith(
      expect.objectContaining({ credential }),
    );
  });
});
