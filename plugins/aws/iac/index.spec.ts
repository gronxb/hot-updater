import type { ClientAccessKeyTable } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirmInitInputPersistence: vi.fn(),
  createBucket: vi.fn(),
  ensureTable: vi.fn(),
  execa: vi.fn(),
  listBuckets: vi.fn(),
  logMessage: vi.fn(),
  makeEnv: vi.fn(),
  readHotUpdaterInitEnv: vi.fn(),
  resolveAwsAuth: vi.fn(),
  runMigrations: vi.fn(),
  selectDistribution: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: mocks.execa,
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

vi.mock("./dynamodb", () => ({
  DynamoDBManager: vi.fn(function DynamoDBManager() {
    return { ensureTable: mocks.ensureTable };
  }),
}));

import {
  prepareDynamoDBClientAccessKey,
  prepareDynamoDBDeployment,
  runInit,
} from "./index";

const EXISTING_API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

const createClientAccessKeyTable = (): ClientAccessKeyTable => ({
  create: vi.fn(async () => "created" as const),
  findByHash: vi.fn(async () => null),
  list: vi.fn(async () => []),
  revoke: vi.fn(async () => null),
});

describe("AWS DynamoDB client access-key preparation", () => {
  it("registers the existing app key without persisting the raw value", async () => {
    const clientAccessKeys = createClientAccessKeyTable();

    const apiKey = await prepareDynamoDBClientAccessKey({
      clientAccessKeys,
      existingApiKey: EXISTING_API_KEY,
    });

    expect(apiKey).toBe(EXISTING_API_KEY);
    expect(clientAccessKeys.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "AWS init", prefix: "AQEBAQ" }),
    );
    expect(
      JSON.stringify(vi.mocked(clientAccessKeys.create).mock.calls),
    ).not.toContain(EXISTING_API_KEY);
  });

  it("creates a canonical app key when the environment has none", async () => {
    const clientAccessKeys = createClientAccessKeyTable();

    const apiKey = await prepareDynamoDBClientAccessKey({ clientAccessKeys });

    expect(apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(clientAccessKeys.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "AWS init",
        prefix: apiKey.slice(0, 6),
      }),
    );
    expect(
      JSON.stringify(vi.mocked(clientAccessKeys.create).mock.calls),
    ).not.toContain(apiKey);
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
  });

  it("ensures the official-domain table before deployment", async () => {
    await prepareDynamoDBDeployment({
      credentials,
      region: "ap-northeast-2",
      tableName: "hot-updater-metadata",
    });

    expect(mocks.ensureTable).toHaveBeenCalledWith("hot-updater-metadata");
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
        HOT_UPDATER_DYNAMODB_TABLE_NAME: "hot-updater",
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

  it("recommends the current managed policy for DynamoDB", async () => {
    // Given
    mocks.readHotUpdaterInitEnv.mockResolvedValue({
      env: {
        HOT_UPDATER_AWS_AUTH_MODE: "local-session",
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
