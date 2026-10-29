import { describe, expect, it } from "vitest";

import { neonStorage } from "./neonStorage";

const endpoint =
  "https://br-quiet-sun-a1b2c3d4.storage.c-5.us-east-2.aws.neon.tech";
const credentials = {
  accessKeyId: "access-key-id",
  secretAccessKey: "secret-access-key",
};

describe("neonStorage", () => {
  it("presigns a path-style URL on the branch's endpoint", async () => {
    const storage = neonStorage({
      basePath: "ota",
      bucketName: "updates",
      credentials,
      endpoint,
      signedUrlExpiresIn: 600,
    });

    const { url } = await storage.getDownloadUrl({
      storageUri: "neon://updates/ota/bundle%20ios.zip",
    });
    const presigned = new URL(url);

    expect(presigned.origin).toBe(endpoint);
    expect(presigned.pathname).toBe("/updates/ota/bundle%20ios.zip");
    expect(presigned.searchParams.get("X-Amz-Expires")).toBe("600");
  });

  it("signs for the region it is given", async () => {
    const storage = neonStorage({
      bucketName: "updates",
      credentials,
      endpoint,
      region: "us-east-2",
    });

    const { url } = await storage.getDownloadUrl({
      storageUri: "neon://updates/bundle.zip",
    });

    expect(new URL(url).searchParams.get("X-Amz-Credential")).toContain(
      "/us-east-2/s3/aws4_request",
    );
  });

  it("rejects an endpoint that is not a URL", () => {
    expect(() =>
      neonStorage({ bucketName: "updates", credentials, endpoint: "" }),
    ).toThrow(/AWS_ENDPOINT_URL_S3/);
  });

  it("rejects an endpoint with the bucket in its path", () => {
    expect(() =>
      neonStorage({
        bucketName: "updates",
        credentials,
        endpoint: `${endpoint}/updates`,
      }),
    ).toThrow(/bucketName/);
  });

  it("rejects a download URL lifetime beyond seven days", () => {
    expect(() =>
      neonStorage({
        bucketName: "updates",
        credentials,
        endpoint,
        signedUrlExpiresIn: 604_801,
      }),
    ).toThrow(/seven days/);
  });

  it("refuses a storage URI from another bucket", async () => {
    const storage = neonStorage({
      bucketName: "updates",
      credentials,
      endpoint,
    });

    await expect(
      storage.getDownloadUrl({ storageUri: "neon://other/bundle.zip" }),
    ).rejects.toThrow(/Bucket name mismatch/);
  });
});
