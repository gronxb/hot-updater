import { describe, expect, it, vi } from "vitest";

import { r2WorkerStorage } from "./r2WorkerStorage";

const createBucket = (get: ReturnType<typeof vi.fn>) =>
  ({
    get,
    head: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  }) as unknown as R2Bucket;

describe("r2WorkerStorage", () => {
  it("reads bytes from the R2 binding captured by the implementation", async () => {
    const get = vi.fn(async (key: string) => ({
      body: new Response(`text:${key}`).body,
      httpEtag: '"etag"',
      size: `text:${key}`.length,
      writeHttpMetadata: vi.fn(),
    }));
    const storage = r2WorkerStorage({
      bucket: createBucket(get),
      bucketName: "bundles",
      downloadUrlSigningKey: "test-signing-key",
    });

    const { response } = await storage.get({
      storageUri: "r2://bundles/app/manifest.json",
    });

    expect(await response?.text()).toBe("text:app/manifest.json");
    expect(get).toHaveBeenCalledWith("app/manifest.json");
  });

  it("rejects URIs owned by a different R2 binding", async () => {
    const get = vi.fn();
    const storage = r2WorkerStorage({
      bucket: createBucket(get),
      bucketName: "bundles",
      downloadUrlSigningKey: "test-signing-key",
    });

    await expect(
      storage.get({ storageUri: "r2://other/app/manifest.json" }),
    ).rejects.toThrow(
      'Bucket name mismatch: expected "bundles", but found "other".',
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("writes and deletes the exact object key through the R2 binding", async () => {
    const bucket = createBucket(vi.fn());
    const storage = r2WorkerStorage({
      bucket,
      bucketName: "bundles",
      downloadUrlSigningKey: "test-signing-key",
    });

    await storage.put({
      key: "releases/bundle.zip",
      body: new TextEncoder().encode("bundle"),
      contentType: "application/zip",
    });
    await expect(
      storage.delete({
        storageUri: "r2://bundles/releases/bundle.zip",
      }),
    ).resolves.toEqual({
      storageUri: "r2://bundles/releases/bundle.zip",
    });

    expect(bucket.put).toHaveBeenCalledWith(
      "releases/bundle.zip",
      expect.any(Uint8Array),
      {
        httpMetadata: {
          cacheControl: "max-age=31536000",
          contentType: "application/zip",
        },
      },
    );
    expect(bucket.delete).toHaveBeenCalledWith("releases/bundle.zip");
  });

  it("returns a stable signed download path for private R2 objects", async () => {
    const storage = r2WorkerStorage({
      bucket: createBucket(vi.fn()),
      bucketName: "bundles",
      downloadUrlSigningKey: "test-signing-key",
    });

    const first = await storage.getDownloadUrl({
      storageUri: "r2://bundles/releases/bundle.zip",
    });
    const second = await storage.getDownloadUrl({
      storageUri: "r2://bundles/releases/bundle.zip",
    });

    expect(first).toEqual(second);
    expect(first.url).toMatch(/^\/storage\//);
  });
});
