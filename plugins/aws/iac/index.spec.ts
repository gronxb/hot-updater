import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cloudFrontCreateOrUpdateDistribution: vi.fn(),
  cloudFrontGetOrCreateKeyGroup: vi.fn(),
  confirmInitInputPersistence: vi.fn(),
  createBucket: vi.fn(),
  ensureInstallPackages: vi.fn(),
  execa: vi.fn(),
  iamCreateOrSelectRole: vi.fn(),
  lambdaDeploy: vi.fn(),
  listBuckets: vi.fn(),
  makeEnv: vi.fn(),
  note: vi.fn(),
  provisionManagedBetterAuthApiKey: vi.fn(),
  readHotUpdaterInitEnv: vi.fn(),
  resolveAwsAuth: vi.fn(),
  runMigrations: vi.fn(),
  s3UpdateBucketPolicy: vi.fn(),
  select: vi.fn(),
  selectDistribution: vi.fn(),
  ssmGetOrCreateKeyPair: vi.fn(),
  text: vi.fn(),
  writeHotUpdaterConfig: vi.fn(),
}));

vi.mock("@hot-updater/better-auth/managed/provisioning", () => ({
  provisionManagedBetterAuthApiKey: mocks.provisionManagedBetterAuthApiKey,
}));

vi.mock("execa", () => ({
  ExecaError: class ExecaError extends Error {},
  execa: mocks.execa,
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();

  return {
    ...actual,
    confirmInitInputPersistence: mocks.confirmInitInputPersistence,
    ensureInstallPackages: mocks.ensureInstallPackages,
    makeEnv: mocks.makeEnv,
    p: {
      ...actual.p,
      note: mocks.note,
      select: mocks.select,
      text: mocks.text,
      tasks: vi.fn(async (tasks) => {
        for (const task of tasks) {
          await task.task(vi.fn());
        }
      }),
    },
    readHotUpdaterInitEnv: mocks.readHotUpdaterInitEnv,
    transformTemplate: vi.fn(() => "source"),
    writeHotUpdaterConfig: mocks.writeHotUpdaterConfig,
  };
});

vi.mock("./awsAuth", () => ({
  resolveAwsAuth: mocks.resolveAwsAuth,
}));

vi.mock("./cloudfront", () => ({
  CloudFrontManager: vi.fn(function CloudFrontManager() {
    return {
      createOrUpdateDistribution: mocks.cloudFrontCreateOrUpdateDistribution,
      getOrCreateKeyGroup: mocks.cloudFrontGetOrCreateKeyGroup,
      selectDistribution: mocks.selectDistribution,
    };
  }),
}));

vi.mock("./iam", () => ({
  IAMManager: vi.fn(function IAMManager() {
    return { createOrSelectRole: mocks.iamCreateOrSelectRole };
  }),
}));

vi.mock("./lambdaEdge", () => ({
  LambdaEdgeDeployer: vi.fn(function LambdaEdgeDeployer() {
    return { deploy: mocks.lambdaDeploy };
  }),
}));

vi.mock("./s3", () => ({
  S3Manager: vi.fn(function S3Manager() {
    return {
      createBucket: mocks.createBucket,
      listBuckets: mocks.listBuckets,
      runMigrations: mocks.runMigrations,
      updateBucketPolicy: mocks.s3UpdateBucketPolicy,
    };
  }),
}));

vi.mock("./ssm", () => ({
  SSMKeyPairManager: vi.fn(function SSMKeyPairManager() {
    return { getOrCreateKeyPair: mocks.ssmGetOrCreateKeyPair };
  }),
}));

vi.mock("./templates", () => ({
  getConfigScaffold: vi.fn(() => ({ text: "config" })),
  SOURCE_TEMPLATE: "%%source%%",
}));

import { runInit } from "./index";

describe("AWS managed initialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execa.mockResolvedValue({ stdout: "aws-cli/2" });
    mocks.readHotUpdaterInitEnv.mockResolvedValue({ env: {}, managedEnv: {} });
    mocks.resolveAwsAuth.mockResolvedValue({
      awsProfile: null,
      configAuthMode: { mode: "local", profile: null },
      credentials: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
      },
      mode: "local-session",
    });
    mocks.select.mockResolvedValueOnce("hot-updater-storage");
    mocks.text.mockResolvedValueOnce("hot-updater-edge");
    mocks.listBuckets.mockResolvedValue([
      { name: "hot-updater-storage", region: "us-east-1" },
    ]);
    mocks.selectDistribution.mockResolvedValue(null);
    mocks.confirmInitInputPersistence.mockResolvedValue(false);
    mocks.iamCreateOrSelectRole.mockResolvedValue(
      "arn:aws:iam::123456789012:role/hot-updater",
    );
    mocks.ssmGetOrCreateKeyPair.mockResolvedValue({
      privateKey: "private-key",
      publicKey: "public-key",
    });
    mocks.cloudFrontGetOrCreateKeyGroup.mockResolvedValue({
      keyGroupId: "key-group",
      publicKeyId: "public-key-id",
    });
    mocks.provisionManagedBetterAuthApiKey.mockResolvedValue({
      apiKey: "raw-client-key",
      sha256: "client-key-digest",
    });
    mocks.lambdaDeploy.mockResolvedValue({
      functionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:hot-updater:1",
      lambdaName: "hot-updater-edge",
    });
    mocks.cloudFrontCreateOrUpdateDistribution.mockResolvedValue({
      distributionDomain: "updates.example.com",
      distributionId: "distribution-id",
    });
    mocks.writeHotUpdaterConfig.mockResolvedValue({ status: "created" });
  });

  it("provisions a reusable client key and injects only its digest into Lambda", async () => {
    await runInit({ build: "bare" });

    expect(mocks.provisionManagedBetterAuthApiKey).toHaveBeenCalledOnce();
    expect(mocks.lambdaDeploy).toHaveBeenCalledWith(
      "arn:aws:iam::123456789012:role/hot-updater",
      "hot-updater-edge",
      expect.objectContaining({
        apiKeySha256: "client-key-digest",
      }),
    );
    expect(JSON.stringify(mocks.note.mock.calls)).not.toContain(
      "raw-client-key",
    );
    expect(JSON.stringify(mocks.makeEnv.mock.calls)).not.toContain(
      "raw-client-key",
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
    const initialization = runInit({
      build: "bare",
      envFile: ".env.hotupdater",
    });

    await expect(initialization).rejects.toMatchObject({
      missingInputs: ["HOT_UPDATER_AWS_MIGRATION_APPROVED"],
    });
    expect(mocks.createBucket).not.toHaveBeenCalled();
  });
});
