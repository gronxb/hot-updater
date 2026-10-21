import { Writable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { firebaseStorage } from "./firebaseStorage";

const stream = (value: string) => new Blob([value]).stream();

const { bucket, file, getStorage } = vi.hoisted(() => {
  const file = {
    delete: vi.fn(),
    download: vi.fn(),
    exists: vi.fn(),
    getMetadata: vi.fn(),
    getSignedUrl: vi.fn(),
    createWriteStream: vi.fn(),
  };
  const bucket = { file: vi.fn(() => file) };
  return {
    bucket,
    file,
    getStorage: vi.fn(() => ({ bucket: vi.fn(() => bucket) })),
  };
});

vi.mock("firebase-admin/app", () => ({
  getApp: vi.fn(() => ({})),
  getApps: vi.fn(() => [{}]),
  initializeApp: vi.fn(() => ({})),
}));
vi.mock("firebase-admin/storage", () => ({ getStorage }));

describe("firebaseStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createStorage = () =>
    firebaseStorage({ projectId: "project", storageBucket: "updates" });

  it("binds its app when created and opens the bucket on first use, so a config loads without its settings", async () => {
    const storage = createStorage();
    expect(getStorage).not.toHaveBeenCalled();
    file.exists.mockResolvedValue([true]);

    await storage.exists({ storageUri: "gs://updates/key" });
    await storage.exists({ storageUri: "gs://updates/key" });

    expect(getStorage).toHaveBeenCalledTimes(1);
  });

  it("returns downloaded bytes as a Web Response", async () => {
    file.download.mockResolvedValue([Buffer.from("manifest")]);
    file.getMetadata.mockResolvedValue([
      { contentType: "application/json", size: "8" },
    ]);

    const { response } = await createStorage().get({
      storageUri: "gs://updates/bundles/manifest.json",
    });

    expect(response).toBeInstanceOf(Response);
    expect(response?.headers.get("content-type")).toBe("application/json");
    expect(response?.headers.get("content-length")).toBe("8");
    await expect(response?.text()).resolves.toBe("manifest");
  });

  it("streams a Web stream and returns an encoded object URI", async () => {
    const chunks: Buffer[] = [];
    file.createWriteStream.mockImplementation(
      () =>
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
        }),
    );

    await expect(
      createStorage().put({
        key: "releases/한글@2x #%.zip",
        body: stream("bundle"),
        contentLength: 6,
        contentType: "application/zip",
      }),
    ).resolves.toEqual({
      storageUri: "gs://updates/releases/%ED%95%9C%EA%B8%80%402x%20%23%25.zip",
    });
    expect(bucket.file).toHaveBeenCalledWith("releases/한글@2x #%.zip");
    expect(file.createWriteStream).toHaveBeenCalledWith({
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
        contentType: "application/zip",
      },
    });
    expect(Buffer.concat(chunks).toString()).toBe("bundle");
  });

  it("deletes exactly one decoded Firebase object and is idempotent", async () => {
    file.delete.mockResolvedValue(undefined);

    const input = {
      storageUri: "gs://updates/releases/%ED%95%9C%EA%B8%80%20%23%25.zip",
    };
    const storage = createStorage();
    await expect(storage.delete(input)).resolves.toEqual({ deleted: true });
    await expect(storage.delete(input)).resolves.toEqual({ deleted: true });

    expect(bucket.file).toHaveBeenCalledWith("releases/한글 #%.zip");
    expect(file.delete).toHaveBeenCalledTimes(2);
    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it("returns null/false for missing objects", async () => {
    file.download.mockRejectedValue({ code: 404 });
    file.exists.mockResolvedValue([false]);
    const storage = createStorage();

    await expect(
      storage.get({ storageUri: "gs://updates/missing.zip" }),
    ).resolves.toEqual({ response: null });
    await expect(
      storage.exists({ storageUri: "gs://updates/missing.zip" }),
    ).resolves.toEqual({ exists: false });
  });

  it("rejects storage URIs owned by another bucket", async () => {
    const storage = createStorage();

    await expect(
      storage.get({ storageUri: "gs://other/bundle.zip" }),
    ).rejects.toThrow('Bucket name mismatch: expected "updates"');
    await expect(
      storage.exists({ storageUri: "gs://other/bundle.zip" }),
    ).rejects.toThrow('Bucket name mismatch: expected "updates"');
    await expect(
      storage.delete({ storageUri: "gs://other/bundle.zip" }),
    ).rejects.toThrow('Bucket name mismatch: expected "updates"');
    expect(bucket.file).not.toHaveBeenCalled();
  });

  it("reuses an object's signed URL until half of its lifetime has passed", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 14) });
    try {
      // Without a private key, every signature is an IAM signBlob request.
      let signed = 0;
      file.getSignedUrl.mockImplementation(async () => [
        `https://storage.googleapis.com/updates/a.png?signature=${(signed += 1)}`,
      ]);
      const storage = firebaseStorage({
        projectId: "project",
        signedUrlExpiresIn: 600,
        storageBucket: "updates",
      });
      const resolve = async (storageUri: string) =>
        (await storage.getDownloadUrl({ storageUri })).url;

      // One update check resolves the same shared asset for many devices.
      const urls = await Promise.all(
        Array.from({ length: 20 }, () => resolve("gs://updates/a.png")),
      );
      vi.advanceTimersByTime(299_000);
      const reused = await resolve("gs://updates/a.png");
      const other = await resolve("gs://updates/b.png");
      vi.advanceTimersByTime(2_000);
      const renewed = await resolve("gs://updates/a.png");

      expect(new Set([...urls, reused])).toEqual(
        new Set(["https://storage.googleapis.com/updates/a.png?signature=1"]),
      );
      expect(other).toContain("signature=2");
      expect(renewed).toContain("signature=3");
      expect(file.getSignedUrl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs again after a failed signature", async () => {
    file.getSignedUrl
      .mockRejectedValueOnce(new Error("signBlob unavailable"))
      .mockResolvedValueOnce(["https://storage.googleapis.com/updates/a.png"]);
    const storage = createStorage();

    await expect(
      storage.getDownloadUrl({ storageUri: "gs://updates/a.png" }),
    ).rejects.toThrow("signBlob unavailable");
    await expect(
      storage.getDownloadUrl({ storageUri: "gs://updates/a.png" }),
    ).resolves.toEqual({ url: "https://storage.googleapis.com/updates/a.png" });
  });

  it("returns a configured CDN URL as its download URL", async () => {
    const storage = firebaseStorage({
      cdnUrl: "https://cdn.example.com/downloads/",
      projectId: "project",
      storageBucket: "updates",
    });

    await expect(
      storage.getDownloadUrl({
        storageUri: "gs://updates/releases/logo%402x.png",
      }),
    ).resolves.toEqual({
      url: "https://cdn.example.com/downloads/releases/logo%402x.png",
    });
    expect(file.getSignedUrl).not.toHaveBeenCalled();
  });
});
