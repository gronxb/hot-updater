import { beforeEach, describe, expect, it, vi } from "vitest";

import { firebaseStorage } from "./firebaseStorage";

const { bucket, file, getStorage } = vi.hoisted(() => {
  const file = {
    delete: vi.fn(),
    download: vi.fn(),
    exists: vi.fn(),
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

    const { response } = await createStorage().get({
      storageUri: "gs://updates/bundles/manifest.json",
    });

    expect(response).toBeInstanceOf(Response);
    await expect(response?.text()).resolves.toBe("manifest");
  });

  it("uploads bytes to the complete object key", async () => {
    file.save.mockResolvedValue(undefined);

    await expect(
      createStorage().put({
        key: "releases/bundle.zip",
        body: new TextEncoder().encode("bundle"),
        contentType: "application/zip",
      }),
    ).resolves.toEqual({
      storageUri: "gs://updates/releases/bundle.zip",
    });
    expect(bucket.file).toHaveBeenCalledWith("releases/bundle.zip");
    expect(file.save).toHaveBeenCalledWith(expect.any(Uint8Array), {
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
        contentType: "application/zip",
      },
    });
  });

  it("deletes exactly one Firebase object", async () => {
    file.delete.mockResolvedValue(undefined);

    await expect(
      createStorage().delete({
        storageUri: "gs://updates/releases/bundle.zip",
      }),
    ).resolves.toEqual({
      storageUri: "gs://updates/releases/bundle.zip",
    });

    expect(bucket.file).toHaveBeenCalledWith("releases/bundle.zip");
    expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it("returns a configured CDN URL as its download URL", async () => {
    const storage = firebaseStorage({
      cdnUrl: "https://cdn.example.com/",
      projectId: "project",
      storageBucket: "updates",
    });

    await expect(
      storage.getDownloadUrl({
        storageUri: "gs://updates/releases/bundle.zip",
      }),
    ).resolves.toEqual({
      url: "https://cdn.example.com/releases/bundle.zip",
    });
    expect(file.getSignedUrl).not.toHaveBeenCalled();
  });
});
