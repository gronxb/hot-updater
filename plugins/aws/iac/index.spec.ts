import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirmInitInputPersistence: vi.fn(),
  createBucket: vi.fn(),
  execa: vi.fn(),
  listBuckets: vi.fn(),
  logMessage: vi.fn(),
  makeEnv: vi.fn(),
  note: vi.fn(),
  provisionManagedBetterAuthApiKey: vi.fn(),
  readHotUpdaterInitEnv: vi.fn(),
  resolveAwsAuth: vi.fn(),
  runMigrations: vi.fn(),
  selectDistribution: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: mocks.execa,
}));

vi.mock("@hot-updater/better-auth/managed/provisioning", () => ({
  provisionManagedBetterAuthApiKey: mocks.provisionManagedBetterAuthApiKey,
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();

  return {
    ...actual,
    confirmInitInputPersistence: mocks.confirmInitInputPersistence,
    makeEnv: mocks.makeEnv,
    p: {
      ...actual.p,
      log: {
        ...actual.p.log,
        message: mocks.logMessage,
      },
      note: mocks.note,
      tasks: vi.fn(async (tasks) => {
        for (const task of tasks) {
          await task.task();
        }
      }),
    },
    readHotUpdaterInitEnv: mocks.readHotUpdaterInitEnv,
  };
});

vi.mock("./awsAuth", () => ({
  resolveAwsAuth: mocks.resolveAwsAuth,
}));

vi.mock("./cloudfront", () => ({
  CloudFrontManager: vi.fn(function CloudFrontManager() {
    return {
      selectDistribution: mocks.selectDistribution,
    };
  }),
}));

vi.mock("./s3", () => ({
  S3Manager: vi.fn(function S3Manager() {
    return {
      createBucket: mocks.createBucket,
      listBuckets: mocks.listBuckets,
      runMigrations: mocks.runMigrations,
    };
  }),
}));

import { provisionDynamoDBClientAccessKey, runInit } from "./index";

describe("AWS managed client access-key provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the initial key in DynamoDB and prints it once", async () => {
    mocks.provisionManagedBetterAuthApiKey.mockResolvedValue({
      apiKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      created: true,
      sha256: "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo",
    });

    await provisionDynamoDBClientAccessKey({
      credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
      },
      envFilePath: ".env.hotupdater",
      region: "ap-northeast-2",
      tableName: "hot-updater",
    });

    expect(mocks.provisionManagedBetterAuthApiKey).toHaveBeenCalledWith({
      envFilePath: ".env.hotupdater",
      name: "Default",
      store: expect.objectContaining({
        create: expect.any(Function),
        findByHash: expect.any(Function),
        list: expect.any(Function),
        revoke: expect.any(Function),
      }),
    });
    expect(mocks.note).toHaveBeenCalledOnce();
    expect(mocks.note).toHaveBeenCalledWith(
      "HOT_UPDATER_API_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "Client access key (shown once)",
    );
  });
});

describe("AWS init preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execa.mockResolvedValue({ stdout: "aws-cli/2" });
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {
        HOT_UPDATER_AWS_AUTH_MODE: "local-session",
        HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
        HOT_UPDATER_S3_BUCKET_NAME: "deleted-bucket",
        HOT_UPDATER_S3_REGION: "ap-northeast-2",
      },
      managedEnv: {},
    });
    mocks.resolveAwsAuth.mockResolvedValue({
      awsProfile: null,
      configAuthMode: { mode: "local", profile: null },
      credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
      },
      mode: "local-session",
    });
    mocks.listBuckets.mockResolvedValue([]);
    mocks.selectDistribution.mockResolvedValue(null);
    mocks.confirmInitInputPersistence.mockResolvedValue(false);
    mocks.runMigrations.mockRejectedValue({
      missingInputs: ["HOT_UPDATER_AWS_MIGRATION_APPROVED"],
    });
  });

  it("rejects missing migration approval before recreating a saved bucket", async () => {
    // Given
    const options = {
      build: "bare",
      envFile: ".env.hotupdater",
    } as const;

    // When
    const initialization = runInit(options);

    // Then
    await expect(initialization).rejects.toMatchObject({
      missingInputs: ["HOT_UPDATER_AWS_MIGRATION_APPROVED"],
    });
    expect(mocks.createBucket).not.toHaveBeenCalled();
  });

  it("recommends the current managed policy when DynamoDB is selected", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {
        HOT_UPDATER_AWS_AUTH_MODE: "local-session",
        HOT_UPDATER_AWS_DATABASE: "dynamodb",
        HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
        HOT_UPDATER_DYNAMODB_TABLE_NAME: "hot-updater",
        HOT_UPDATER_S3_BUCKET_NAME: "deleted-bucket",
        HOT_UPDATER_S3_REGION: "ap-northeast-2",
      },
      managedEnv: {},
    });
    const options = {
      build: "bare",
      envFile: ".env.hotupdater",
    } as const;

    // When
    const initialization = runInit(options);

    // Then
    await expect(initialization).rejects.toMatchObject({
      missingInputs: ["HOT_UPDATER_AWS_MIGRATION_APPROVED"],
    });
    expect(mocks.logMessage).toHaveBeenCalledWith(
      expect.stringContaining("AmazonDynamoDBFullAccess_v2"),
    );
  });
});
