import { describe, expect, it, vi } from "vitest";

import { createS3Storage } from "./createS3Storage";

const identity = { name: "testStorage", protocol: "test" };
const options = {
  bucketName: "updates",
  credentials: {
    accessKeyId: "access-key-id",
    secretAccessKey: "secret-access-key",
  },
  endpoint: "https://storage.example.com",
  forcePathStyle: true,
  region: "us-east-1",
};

describe("createS3Storage", () => {
  it("names the adapter and writes URIs under its protocol", async () => {
    const storage = createS3Storage(identity, options);

    expect(storage.name).toBe("testStorage");
    expect(storage.protocol).toBe("test");
    await expect(
      storage.getDownloadUrl({ storageUri: "s3://updates/bundle.zip" }),
    ).rejects.toThrow();
  });

  it("presigns for an hour unless told otherwise", async () => {
    const hour = createS3Storage(identity, options);
    const tenMinutes = createS3Storage(identity, {
      ...options,
      signedUrlExpiresIn: 600,
    });

    const expiresIn = async (storage: typeof hour) =>
      new URL(
        (await storage.getDownloadUrl({ storageUri: "test://updates/a.zip" }))
          .url,
      ).searchParams.get("X-Amz-Expires");

    await expect(expiresIn(hour)).resolves.toBe("3600");
    await expect(expiresIn(tenMinutes)).resolves.toBe("600");
  });

  it("rejects a download URL lifetime beyond seven days", () => {
    expect(() =>
      createS3Storage(identity, { ...options, signedUrlExpiresIn: 604_801 }),
    ).toThrow(/testStorage signedUrlExpiresIn .* \(seven days\)/);
    expect(() =>
      createS3Storage(identity, { ...options, signedUrlExpiresIn: 0 }),
    ).toThrow(/seven days/);
  });

  it("returns the configured getDownloadUrl's URL for its own bucket only", async () => {
    const getDownloadUrl = vi.fn(async () => ({
      url: "https://cdn.example.com/a.zip",
    }));
    const storage = createS3Storage(identity, { ...options, getDownloadUrl });

    await expect(
      storage.getDownloadUrl({ storageUri: "test://updates/a.zip" }),
    ).resolves.toEqual({ url: "https://cdn.example.com/a.zip" });
    await expect(
      storage.getDownloadUrl({ storageUri: "test://other/a.zip" }),
    ).rejects.toThrow('Bucket name mismatch: expected "updates"');
    expect(getDownloadUrl).toHaveBeenCalledOnce();
  });
});
