import { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createNodeStorageContext } from "@hot-updater/plugin-core/storage/node";
import { expect, it, vi } from "vitest";

import { r2Storage } from "./node";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => "https://signed-r2.example.test/object"),
}));

const credentials = {
  accessKeyId: "literal-access-key",
  secretAccessKey: "literal-secret-key",
} as const;

it("issues presigned and public R2 downloads", async () => {
  // Given
  const context = createNodeStorageContext({ environment: {} });
  const presigned = r2Storage({
    accountId: "account",
    bucketName: "storage-v2",
    credentials,
  });
  const publicStorage = r2Storage({
    accountId: "account",
    bucketName: "storage-v2",
    credentials,
    publicBaseUrl: "https://assets.example.test/base",
  });

  // When
  const signedResult = await presigned.issueDownload?.({
    context,
    expiresInSeconds: 120,
    storageUri: "r2://storage-v2/releases/app.zip",
  });
  const publicResult = await publicStorage.issueDownload?.({
    context,
    storageUri: "r2://storage-v2/releases/app.zip",
  });

  // Then
  expect(signedResult).toEqual({
    kind: "issued",
    downloadUrl: "https://signed-r2.example.test/object",
  });
  expect(getSignedUrl).toHaveBeenCalledWith(
    expect.any(S3Client),
    expect.anything(),
    { expiresIn: 120 },
  );
  expect(publicResult).toEqual({
    kind: "issued",
    downloadUrl: "https://assets.example.test/storage-v2/releases/app.zip",
  });
  await Promise.all([presigned.onUnmount?.(), publicStorage.onUnmount?.()]);
});
