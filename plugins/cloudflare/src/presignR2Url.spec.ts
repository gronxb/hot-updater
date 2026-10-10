import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { describe, expect, it } from "vitest";

import { presignR2GetUrl } from "./presignR2Url";

const credentials = {
  accessKeyId: "access-key-id",
  secretAccessKey: "secret-access-key",
};
const signingDate = new Date("2026-10-10T01:02:03.456Z");

/**
 * The URL the AWS SDK presigns on R2's endpoint, without the checksum
 * parameters its defaults add, such as `x-amz-checksum-mode`.
 */
const presignWithSdk = (key: string) =>
  getSignedUrl(
    new S3Client({
      credentials,
      endpoint: "https://account-id.r2.cloudflarestorage.com",
      forcePathStyle: true,
      region: "auto",
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
    new GetObjectCommand({ Bucket: "updates", Key: key }),
    { expiresIn: 3600, signingDate },
  );

describe("presignR2GetUrl", () => {
  it.each([
    "releases/bundle.zip",
    "releases/logo@2x.png",
    "assets/sha256/aa/한글 100%.br",
    "assets/(draft)/it's*!.txt",
  ])("signs %s as the AWS SDK presigner does", async (key) => {
    const url = await presignR2GetUrl({
      accountId: "account-id",
      bucketName: "updates",
      credentials,
      expiresInSeconds: 3600,
      key,
      signingDate,
    });

    expect(url).toBe(await presignWithSdk(key));
  });
});
