import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirmInitInputPersistence: vi.fn(),
  createBucket: vi.fn(),
  dynamoDB: vi.fn(),
  ensureTable: vi.fn(),
  execa: vi.fn(),
  listBuckets: vi.fn(),
  logMessage: vi.fn(),
  makeEnv: vi.fn(),
  migrateUniversalComponents: vi.fn(),
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

vi.mock("@hot-updater/server/db", () => ({
  migrateUniversalComponents: mocks.migrateUniversalComponents,
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

vi.mock("../src/dynamodbDatabase", () => ({
  dynamoDB: mocks.dynamoDB,
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

vi.mock("./dynamodb", () => ({
  DynamoDBManager: vi.fn(function DynamoDBManager() {
    return { ensureTable: mocks.ensureTable };
  }),
}));

import {
  prepareDynamoDBDeployment,
  provisionDynamoDBClientAccessKey,
  runInit,
} from "./index";

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

describe("AWS DynamoDB deployment preparation", () => {
  const credentials = {
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureTable.mockResolvedValue(undefined);
    mocks.dynamoDB.mockReturnValue({ name: "dynamoDB" });
    mocks.migrateUniversalComponents.mockResolvedValue([]);
    mocks.provisionManagedBetterAuthApiKey.mockResolvedValue({
      apiKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      created: false,
      sha256: "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo",
    });
  });

  it("migrates the composed component target after table readiness and before key provisioning", async () => {
    const order: string[] = [];
    const deploymentTarget = { adapterName: "dynamoDB" };
    mocks.ensureTable.mockImplementation(async () => {
      order.push("table");
    });
    mocks.dynamoDB.mockImplementation(() => {
      order.push("provider");
      return { name: "dynamoDB" };
    });
    const createDeploymentTarget = vi.fn(() => {
      order.push("target");
      return deploymentTarget;
    });
    mocks.migrateUniversalComponents.mockImplementation(async () => {
      order.push("migration");
      return [];
    });
    mocks.provisionManagedBetterAuthApiKey.mockImplementation(async () => {
      order.push("access-key");
      return {
        apiKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        created: false,
        sha256: "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo",
      };
    });

    await prepareDynamoDBDeployment({
      createDeploymentTarget,
      credentials,
      envFilePath: ".env.hotupdater",
      region: "ap-northeast-2",
      tableName: "hot-updater-metadata",
    });

    expect(order).toEqual([
      "table",
      "provider",
      "target",
      "migration",
      "access-key",
    ]);
    expect(mocks.dynamoDB).toHaveBeenCalledWith({
      credentials,
      region: "ap-northeast-2",
      tableName: "hot-updater-metadata",
    });
    expect(mocks.migrateUniversalComponents).toHaveBeenCalledWith(
      deploymentTarget,
    );
  });

  it("does not provision a key when component migration fails", async () => {
    const migrationError = new Error("component schema is incompatible");
    mocks.migrateUniversalComponents.mockRejectedValue(migrationError);

    await expect(
      prepareDynamoDBDeployment({
        createDeploymentTarget: () => ({ adapterName: "dynamoDB" }),
        credentials,
        envFilePath: ".env.hotupdater",
        region: "ap-northeast-2",
        tableName: "hot-updater-metadata",
      }),
    ).rejects.toBe(migrationError);

    expect(mocks.ensureTable).toHaveBeenCalledOnce();
    expect(mocks.provisionManagedBetterAuthApiKey).not.toHaveBeenCalled();
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
    expect(mocks.migrateUniversalComponents).not.toHaveBeenCalled();
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
