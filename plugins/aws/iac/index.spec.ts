import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cloudFrontCreateOrUpdateDistribution: vi.fn(),
  cloudFrontGetOrCreateKeyGroup: vi.fn(),
  ensureInstallPackages: vi.fn(),
  execa: vi.fn(),
  fromNodeProviderChain: vi.fn(),
  iamCreateOrSelectRole: vi.fn(),
  lambdaDeploy: vi.fn(),
  makeEnv: vi.fn(),
  note: vi.fn(),
  provisionManagedBetterAuthApiKey: vi.fn(),
  s3ListBuckets: vi.fn(),
  s3RunMigrations: vi.fn(),
  s3UpdateBucketPolicy: vi.fn(),
  select: vi.fn(),
  ssmGetOrCreateKeyPair: vi.fn(),
  writeHotUpdaterConfig: vi.fn(),
}));

vi.mock("@hot-updater/better-auth/managed/provisioning", () => ({
  provisionManagedBetterAuthApiKey: mocks.provisionManagedBetterAuthApiKey,
}));

vi.mock("@aws-sdk/credential-providers", () => ({
  fromIni: vi.fn(),
  fromNodeProviderChain: mocks.fromNodeProviderChain,
  fromSSO: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", () => ({
  colors: { blue: (value: string) => value },
  ensureInstallPackages: mocks.ensureInstallPackages,
  link: (value: string) => value,
  makeEnv: mocks.makeEnv,
  p: {
    isCancel: () => false,
    log: {
      error: vi.fn(),
      info: vi.fn(),
      message: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
    note: mocks.note,
    select: mocks.select,
    tasks: async (
      tasks: readonly {
        readonly task: (message: (value: string) => void) => Promise<unknown>;
      }[],
    ) => {
      for (const task of tasks) {
        await task.task(vi.fn());
      }
    },
  },
  transformTemplate: vi.fn(() => "source"),
  writeHotUpdaterConfig: mocks.writeHotUpdaterConfig,
}));

vi.mock("execa", () => ({
  ExecaError: class ExecaError extends Error {},
  execa: mocks.execa,
}));

vi.mock("./cloudfront", () => ({
  CloudFrontManager: vi.fn(function CloudFrontManager() {
    return {
      createOrUpdateDistribution: mocks.cloudFrontCreateOrUpdateDistribution,
      getOrCreateKeyGroup: mocks.cloudFrontGetOrCreateKeyGroup,
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
      listBuckets: mocks.s3ListBuckets,
      runMigrations: mocks.s3RunMigrations,
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

describe("AWS managed initialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execa.mockResolvedValue({});
    mocks.fromNodeProviderChain.mockReturnValue(async () => ({
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    }));
    mocks.select
      .mockResolvedValueOnce("local-session")
      .mockResolvedValueOnce("hot-updater-storage");
    mocks.s3ListBuckets.mockResolvedValue([
      { name: "hot-updater-storage", region: "us-east-1" },
    ]);
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
      lambdaName: "hot-updater",
    });
    mocks.cloudFrontCreateOrUpdateDistribution.mockResolvedValue({
      distributionDomain: "updates.example.com",
      distributionId: "distribution-id",
    });
    mocks.writeHotUpdaterConfig.mockResolvedValue({ status: "created" });
  });

  it("provisions a reusable client key and injects only its digest into Lambda", async () => {
    // Given: managed AWS resources can be created with the current CLI session.
    const { runInit } = await import("./index");

    // When: initialization deploys the managed runtime.
    await runInit({ build: "bare" });

    // Then: the raw key stays in .env.hotupdater and only its digest is deployed.
    expect(mocks.provisionManagedBetterAuthApiKey).toHaveBeenCalledOnce();
    expect(mocks.lambdaDeploy).toHaveBeenCalledWith(
      "arn:aws:iam::123456789012:role/hot-updater",
      expect.objectContaining({
        apiKeySha256: "client-key-digest",
      }),
    );
    expect(mocks.lambdaDeploy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiKey: "raw-client-key" }),
    );
    expect(JSON.stringify(mocks.note.mock.calls)).not.toContain(
      "raw-client-key",
    );
    expect(JSON.stringify(mocks.makeEnv.mock.calls)).not.toContain(
      "raw-client-key",
    );
  });
});
