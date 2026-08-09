import { beforeEach, describe, expect, it, vi } from "vitest";

const mockS3 = vi.hoisted(() => ({
  getBucketLocation: vi.fn(),
  getBucketPolicy: vi.fn(),
  listBuckets: vi.fn(),
  putBucketPolicy: vi.fn(),
}));

const mockPrompt = vi.hoisted(() => ({
  log: {
    info: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
  },
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
}));

const mockMigrator = vi.hoisted(() => ({
  list: vi.fn(),
  migrate: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3: vi.fn(function S3() {
    return mockS3;
  }),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    p: mockPrompt,
  };
});

vi.mock("./migrations/migrator", () => ({
  S3Migrator: vi.fn(function S3Migrator() {
    return mockMigrator;
  }),
}));

import { S3Manager } from "./s3";

describe("S3Manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockS3.putBucketPolicy.mockResolvedValue({});
  });

  it("normalizes us-east-1 buckets when AWS omits the location constraint", async () => {
    mockS3.listBuckets.mockResolvedValue({
      Buckets: [{ Name: "east-bucket" }, { Name: "seoul-bucket" }],
    });
    mockS3.getBucketLocation
      .mockResolvedValueOnce({ LocationConstraint: null })
      .mockResolvedValueOnce({ LocationConstraint: "ap-northeast-2" });
    const manager = new S3Manager({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await expect(manager.listBuckets()).resolves.toEqual([
      { name: "east-bucket", region: "us-east-1" },
      { name: "seoul-bucket", region: "ap-northeast-2" },
    ]);
  });

  it("normalizes the legacy EU alias to eu-west-1", async () => {
    mockS3.listBuckets.mockResolvedValue({
      Buckets: [{ Name: "legacy-eu-bucket" }],
    });
    mockS3.getBucketLocation.mockResolvedValue({
      LocationConstraint: "EU",
    });
    const manager = new S3Manager({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await expect(manager.listBuckets()).resolves.toEqual([
      { name: "legacy-eu-bucket", region: "eu-west-1" },
    ]);
  });

  it("does not prompt when there are no pending migrations", async () => {
    // Given
    mockMigrator.list.mockResolvedValue({ pending: [] });
    mockMigrator.migrate.mockResolvedValue(undefined);
    const manager = new S3Manager({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.runMigrations({
      bucketName: "existing-bucket",
      region: "ap-northeast-2",
      migrations: [],
    });

    // Then
    expect(mockPrompt.confirm).not.toHaveBeenCalled();
  });

  it("runs approved non-interactive migrations without prompting", async () => {
    // Given
    mockMigrator.list.mockResolvedValue({
      pending: [{ name: "Migration0001" }],
    });
    mockMigrator.migrate.mockResolvedValue(undefined);
    const manager = new S3Manager({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.runMigrations({
      approved: true,
      bucketName: "existing-bucket",
      nonInteractive: true,
      region: "ap-northeast-2",
      migrations: [],
    });

    // Then
    expect(mockPrompt.confirm).not.toHaveBeenCalled();
    expect(mockMigrator.migrate).toHaveBeenLastCalledWith({ dryRun: false });
  });

  it("asks again with saved migration approval as the interactive default", async () => {
    // Given
    mockMigrator.list.mockResolvedValue({
      pending: [{ name: "Migration0001" }],
    });
    mockMigrator.migrate.mockResolvedValue(undefined);
    mockPrompt.confirm.mockResolvedValue(true);
    const manager = new S3Manager({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.runMigrations({
      approved: true,
      bucketName: "existing-bucket",
      nonInteractive: false,
      region: "ap-northeast-2",
      migrations: [],
    });

    // Then
    expect(mockPrompt.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: true }),
    );
  });

  it("requires approval only after finding pending non-interactive migrations", async () => {
    // Given
    mockMigrator.list.mockResolvedValue({
      pending: [{ name: "Migration0001" }],
    });
    mockMigrator.migrate.mockResolvedValue(undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    const manager = new S3Manager({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    const migrations = manager.runMigrations({
      bucketName: "existing-bucket",
      nonInteractive: true,
      region: "ap-northeast-2",
      migrations: [],
    });

    // Then
    await expect(migrations).rejects.toMatchObject({
      missingInputs: ["HOT_UPDATER_AWS_MIGRATION_APPROVED"],
    });
    expect(mockPrompt.confirm).not.toHaveBeenCalled();
  });

  it("preserves unrelated statements when granting CloudFront access", async () => {
    // Given
    const unrelatedStatement = {
      Sid: "AllowAudit",
      Effect: "Allow",
      Principal: { AWS: "arn:aws:iam::123456789012:role/audit" },
      Action: "s3:GetBucketLocation",
      Resource: "arn:aws:s3:::hot-updater-storage",
    };
    mockS3.getBucketPolicy.mockResolvedValue({
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [unrelatedStatement],
      }),
    });
    const manager = new S3Manager({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.updateBucketPolicy({
      accountId: "123456789012",
      bucketName: "hot-updater-storage",
      distributionId: "distribution-id",
      region: "ap-northeast-2",
    });

    // Then
    const policy = JSON.parse(
      mockS3.putBucketPolicy.mock.calls[0]?.[0].Policy ?? "{}",
    );
    expect(policy.Statement).toEqual(
      expect.arrayContaining([
        unrelatedStatement,
        expect.objectContaining({ Sid: "AllowHotUpdaterCloudFrontRead" }),
      ]),
    );
  });
});
