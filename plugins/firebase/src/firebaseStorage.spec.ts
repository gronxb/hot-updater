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
    save: vi.fn(),
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

  it("buffers a Web stream and returns an encoded object URI", async () => {
    file.save.mockResolvedValue(undefined);

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
    expect(file.save).toHaveBeenCalledWith(new TextEncoder().encode("bundle"), {
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
        contentType: "application/zip",
      },
    });
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
