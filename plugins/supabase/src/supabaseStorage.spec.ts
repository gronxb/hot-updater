import { beforeEach, describe, expect, it, vi } from "vitest";

import { supabaseStorage } from "./supabaseStorage";

const { bucket, createClient } = vi.hoisted(() => {
  const bucket = {
    createSignedUrl: vi.fn(),
    download: vi.fn(),
    exists: vi.fn(),
    remove: vi.fn(),
    upload: vi.fn(),
  };
  return {
    bucket,
    createClient: vi.fn(() => ({
      storage: { from: vi.fn(() => bucket) },
    })),
  };
});

vi.mock("@supabase/supabase-js", () => ({ createClient }));

describe("supabaseStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createStorage = () =>
    supabaseStorage({
      bucketName: "updates",
      supabaseAnonKey: "anon-key",
      supabaseUrl: "https://example.supabase.co",
    });

  it("checks existence without coupling storage to URL signing", async () => {
    bucket.exists.mockResolvedValue({ data: true, error: null });

    await expect(
      createStorage().exists({
        storageUri: "supabase-storage://updates/assets/sha256/fi/file-hash.png",
      }),
    ).resolves.toEqual({ exists: true });
    expect(bucket.exists).toHaveBeenCalledWith(
      "assets/sha256/fi/file-hash.png",
    );
  });

  it("does not treat provider failures as a missing object", async () => {
    const error = new Error("storage unavailable");
    bucket.exists.mockResolvedValue({ data: false, error });

    await expect(
      createStorage().exists({
        storageUri: "supabase-storage://updates/bundle.zip",
      }),
    ).rejects.toBe(error);
  });

  it("returns a Web Response for provider reads", async () => {
    bucket.download.mockResolvedValue({
      data: new Blob(["manifest"]),
      error: null,
    });

    const { response } = await createStorage().get({
      storageUri: "supabase-storage://updates/bundles/manifest.json",
    });

    expect(response).toBeInstanceOf(Response);
    await expect(response?.text()).resolves.toBe("manifest");
  });

  it("uploads bytes and returns a stable storage URI", async () => {
    bucket.upload.mockResolvedValue({
      data: { fullPath: "updates/bundles/bundle.zip" },
      error: null,
    });

    await expect(
      createStorage().put({
        key: "bundles/bundle.zip",
        body: new TextEncoder().encode("bundle"),
        contentType: "application/zip",
      }),
    ).resolves.toEqual({
      storageUri: "supabase-storage://updates/bundles/bundle.zip",
    });
  });

  it("deletes exactly the referenced object", async () => {
    bucket.remove.mockResolvedValue({ error: null });

    await expect(
      createStorage().delete({
        storageUri: "supabase-storage://updates/releases/bundle.zip",
      }),
    ).resolves.toEqual({
      storageUri: "supabase-storage://updates/releases/bundle.zip",
    });

    expect(bucket.remove).toHaveBeenCalledWith(["releases/bundle.zip"]);
  });

  it("returns a Supabase signed download URL", async () => {
    bucket.createSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://example.supabase.co/signed" },
      error: null,
    });

    await expect(
      createStorage().getDownloadUrl({
        storageUri: "supabase-storage://updates/assets/file-hash.png",
      }),
    ).resolves.toEqual({ url: "https://example.supabase.co/signed" });
    expect(bucket.createSignedUrl).toHaveBeenCalledWith(
      "assets/file-hash.png",
      3600,
    );
  });
});
