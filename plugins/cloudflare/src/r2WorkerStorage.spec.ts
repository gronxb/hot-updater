import { afterEach, describe, expect, it, vi } from "vitest";

import { r2WorkerStorage } from "./r2WorkerStorage";

const createBucket = (
  get: ReturnType<typeof vi.fn>,
  overrides: Partial<R2Bucket> = {},
) =>
  ({
    get,
    head: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    ...overrides,
  }) as unknown as R2Bucket;

describe("r2WorkerStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
    });

    await expect(
      storage.get({ storageUri: "r2://other/app/manifest.json" }),
    ).rejects.toThrow(
      'Bucket name mismatch: expected "bundles", but found "other".',
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("writes and deletes the exact object key through the R2 binding", async () => {
    let uploaded = "";
    const put = vi.fn(async (_key: string, body: Uint8Array) => {
      uploaded = new TextDecoder().decode(body);
      return null;
    });
    const bucket = createBucket(vi.fn(), {
      put: put as unknown as R2Bucket["put"],
    });
    const storage = r2WorkerStorage({
      bucket,
      bucketName: "bundles",
    });

    await storage.put({
      key: "releases/bundle.zip",
      body: new Response("bundle").body!,
      contentType: "application/zip",
    });
    await expect(
      storage.delete({
        storageUri: "r2://bundles/releases/bundle.zip",
      }),
    ).resolves.toEqual({
      deleted: true,
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
    expect(uploaded).toBe("bundle");
    expect(bucket.delete).toHaveBeenCalledWith("releases/bundle.zip");
  });

  it("round-trips reserved characters without changing the R2 binding key", async () => {
    const bucket = createBucket(vi.fn());
    const storage = r2WorkerStorage({
      bucket,
      bucketName: "bundles",
    });
    const key = "릴리스 folder/logo@2x #100%/bundle.zip";

    const uploaded = await storage.put({
      key,
      body: new Response("bundle").body!,
      contentType: "application/zip",
    });
    expect(uploaded.storageUri).toContain("logo%402x");
    await storage.delete({ storageUri: uploaded.storageUri });
    await storage.delete({ storageUri: uploaded.storageUri });

    expect(bucket.put).toHaveBeenCalledWith(
      key,
      expect.any(Uint8Array),
      expect.any(Object),
    );
    expect(bucket.delete).toHaveBeenNthCalledWith(1, key);
    expect(bucket.delete).toHaveBeenNthCalledWith(2, key);
  });

  it("uses a fixed-length stream when the upload length is known", async () => {
    const expectedLengths: number[] = [];
    class TestFixedLengthStream extends TransformStream<
      Uint8Array,
      Uint8Array
    > {
      constructor(expectedLength: number) {
        super();
        expectedLengths.push(expectedLength);
      }
    }
    vi.stubGlobal("FixedLengthStream", TestFixedLengthStream);
    let uploaded = "";
    const put = vi.fn(
      async (_key: string, body: ReadableStream<Uint8Array>) => {
        uploaded = await new Response(body).text();
        return null;
      },
    );
    const storage = r2WorkerStorage({
      bucket: createBucket(vi.fn(), {
        put: put as unknown as R2Bucket["put"],
      }),
      bucketName: "bundles",
    });

    await storage.put({
      key: "releases/bundle.zip",
      body: new Response("bundle").body!,
      contentLength: 6,
      contentType: "application/zip",
    });

    expect(expectedLengths).toEqual([6]);
    expect(uploaded).toBe("bundle");
  });

  it("presigns download URLs on the account's R2 endpoint for an hour", async () => {
    const storage = r2WorkerStorage({
      bucket: createBucket(vi.fn()),
      bucketName: "bundles",
      accountId: "account-id",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
    });

    const { url } = await storage.getDownloadUrl({
      storageUri: "r2://bundles/releases/logo%402x.png",
    });

    const presigned = new URL(url);
    expect(presigned.origin).toBe(
      "https://account-id.r2.cloudflarestorage.com",
    );
    expect(presigned.pathname).toBe("/bundles/releases/logo%402x.png");
    expect(presigned.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(presigned.searchParams.get("X-Amz-Signature")).toMatch(
      /^[0-9a-f]{64}$/,
    );
    await expect(
      storage.getDownloadUrl({ storageUri: "r2://other/releases/bundle.zip" }),
    ).rejects.toThrow('Bucket name mismatch: expected "bundles"');
  });

  it("has no download URLs without R2's S3-compatible credentials", () => {
    const storage = r2WorkerStorage({
      bucket: createBucket(vi.fn()),
      bucketName: "bundles",
    });

    expect(storage).not.toHaveProperty("getDownloadUrl");
  });
});
