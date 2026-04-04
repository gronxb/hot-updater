import { beforeEach, describe, expect, it, vi } from "vitest";

const mockS3 = vi.hoisted(() => ({
  listBuckets: vi.fn(),
  getBucketLocation: vi.fn(),
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

vi.mock("@aws-sdk/client-s3", () => ({
  S3: vi.fn(function S3() {
    return mockS3;
  }),
}));

vi.mock("@hot-updater/cli-tools", () => ({
  p: mockPrompt,
}));

import { S3Manager } from "./s3";

describe("S3Manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
