import { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl as getCloudFrontSignedUrl } from "@aws-sdk/cloudfront-signer";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  StorageOperationContext,
  StoragePlugin,
} from "@hot-updater/plugin-core/storage";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { s3Storage } from "./storage/node";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => "https://s3.example.test/signed"),
}));
vi.mock("@aws-sdk/cloudfront-signer", () => ({
  getSignedUrl: vi.fn(() => "https://cdn.example.test/signed"),
}));

const context = createNodeStorageContext({ environment: {} });
const credentials = {
  accessKeyId: "literal-access-key",
  secretAccessKey: "literal-secret-key",
} as const;

const assertIssued = async (
  plugin: StoragePlugin<StorageOperationContext>,
): Promise<void> => {
  const result = await plugin.issueDownload?.({
    context,
    storageUri: "s3://storage-v2/release.zip",
    expiresInSeconds: 120,
  });
  expect(result?.kind).toBe("issued");
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AWS S3 Storage v2 delivery", () => {
  it("issues a presigned S3 download", async () => {
    // Given
    const plugin = s3Storage({
      bucketName: "storage-v2",
      region: "us-east-1",
      credentials,
      delivery: { type: "presigned" },
    });

    // When
    await assertIssued(plugin);

    // Then
    expect(getS3SignedUrl).toHaveBeenCalledWith(
      expect.any(S3Client),
      expect.anything(),
      { expiresIn: 120 },
    );
    await plugin.onUnmount?.();
  });

  it("issues a CloudFront download", async () => {
    // Given
    const plugin = s3Storage({
      bucketName: "storage-v2",
      region: "us-east-1",
      credentials,
      delivery: {
        type: "cloudfront",
        publicBaseUrl: "https://cdn.example.test/base",
        keyPairId: "K123",
        privateKey: "private-key",
      },
    });

    // When
    await assertIssued(plugin);

    // Then
    expect(getCloudFrontSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://cdn.example.test/release.zip",
        keyPairId: "K123",
        privateKey: "private-key",
      }),
    );
    await plugin.onUnmount?.();
  });
});
