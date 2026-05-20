import fs from "fs/promises";
import os from "os";
import path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { supabaseStorage } from "./supabaseStorage";

const { bucket, createClient } = vi.hoisted(() => {
  const bucket = {
    createSignedUrl: vi.fn(),
    exists: vi.fn(),
    upload: vi.fn(),
  };

  return {
    bucket,
    createClient: vi.fn(() => ({
      storage: {
        from: vi.fn(() => bucket),
      },
    })),
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient,
}));

describe("supabaseStorage", () => {
  beforeEach(() => {
    bucket.createSignedUrl.mockReset();
    bucket.exists.mockReset();
    bucket.upload.mockReset();
    createClient.mockClear();
  });

  it("checks object existence with the Supabase storage exists API", async () => {
    bucket.exists.mockResolvedValueOnce({ data: true, error: null });

    const storage = supabaseStorage({
      bucketName: "updates",
      supabaseAnonKey: "anon-key",
      supabaseUrl: "https://example.supabase.co",
    })();

    await expect(
      storage.profiles.node.exists(
        "supabase-storage://updates/assets/sha256/fi/file-hash.png",
      ),
    ).resolves.toBe(true);

    expect(bucket.exists).toHaveBeenCalledWith(
      "assets/sha256/fi/file-hash.png",
    );
  });

  it("returns false when Supabase reports the object is missing", async () => {
    bucket.exists.mockResolvedValueOnce({
      data: false,
      error: new Error("Object not found"),
    });

    const storage = supabaseStorage({
      bucketName: "updates",
      supabaseAnonKey: "anon-key",
      supabaseUrl: "https://example.supabase.co",
    })();

    await expect(
      storage.profiles.node.exists(
        "supabase-storage://updates/assets/sha256/fi/file-hash.png",
      ),
    ).resolves.toBe(false);
  });

  it("rethrows Supabase storage existence errors", async () => {
    const error = new Error("Storage API failed");
    bucket.exists.mockRejectedValueOnce(error);

    const storage = supabaseStorage({
      bucketName: "updates",
      supabaseAnonKey: "anon-key",
      supabaseUrl: "https://example.supabase.co",
    })();

    await expect(
      storage.profiles.node.exists(
        "supabase-storage://updates/assets/sha256/fi/file-hash.png",
      ),
    ).rejects.toBe(error);
  });

  it("rejects existence checks for a different bucket", async () => {
    const storage = supabaseStorage({
      bucketName: "updates",
      supabaseAnonKey: "anon-key",
      supabaseUrl: "https://example.supabase.co",
    })();

    await expect(
      storage.profiles.node.exists(
        "supabase-storage://other/assets/sha256/fi/file-hash.png",
      ),
    ).rejects.toThrow(
      'Bucket name mismatch: expected "updates", but found "other".',
    );
    expect(bucket.exists).not.toHaveBeenCalled();
  });

  it("retries signed URL generation when Supabase reports a missing object", async () => {
    bucket.createSignedUrl
      .mockResolvedValueOnce({
        data: null,
        error: new Error("Object not found"),
      })
      .mockResolvedValueOnce({
        data: { signedUrl: "https://example.supabase.co/signed-url" },
        error: null,
      });

    const storage = supabaseStorage({
      bucketName: "updates",
      supabaseAnonKey: "anon-key",
      supabaseUrl: "https://example.supabase.co",
    })();

    await expect(
      storage.profiles.runtime.getDownloadUrl(
        "supabase-storage://updates/assets/sha256/fi/file-hash.png",
        {},
      ),
    ).resolves.toEqual({
      fileUrl: "https://example.supabase.co/signed-url",
    });

    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(2);
    expect(bucket.createSignedUrl).toHaveBeenCalledWith(
      "assets/sha256/fi/file-hash.png",
      3600,
    );
  });

  it("waits for uploaded objects to become signable", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hu-supabase-"));
    const uploadPath = path.join(tmpDir, "bundle.zip");
    await fs.writeFile(uploadPath, "bundle");
    bucket.upload.mockResolvedValueOnce({
      data: { fullPath: "updates/bundles/bundle.zip" },
      error: null,
    });
    bucket.createSignedUrl
      .mockResolvedValueOnce({
        data: null,
        error: new Error("Object not found"),
      })
      .mockResolvedValueOnce({
        data: { signedUrl: "https://example.supabase.co/signed-url" },
        error: null,
      });

    const storage = supabaseStorage({
      bucketName: "updates",
      supabaseAnonKey: "anon-key",
      supabaseUrl: "https://example.supabase.co",
    })();

    await expect(
      storage.profiles.node.upload("bundles", uploadPath),
    ).resolves.toEqual({
      storageUri: "supabase-storage://updates/bundles/bundle.zip",
    });

    expect(bucket.upload).toHaveBeenCalledWith(
      "bundles/bundle.zip",
      expect.any(Buffer),
      expect.objectContaining({
        cacheControl: "max-age=31536000",
        contentType: "application/zip",
      }),
    );
    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(2);
    expect(bucket.createSignedUrl).toHaveBeenCalledWith(
      "bundles/bundle.zip",
      3600,
    );

    await fs.rm(tmpDir, { force: true, recursive: true });
  });

  it("retries signed URL generation when Supabase throws a missing object error", async () => {
    bucket.createSignedUrl
      .mockRejectedValueOnce(
        new Error("Failed to generate download URL: Object not found"),
      )
      .mockResolvedValueOnce({
        data: { signedUrl: "https://example.supabase.co/signed-url" },
        error: null,
      });

    const storage = supabaseStorage({
      bucketName: "updates",
      supabaseAnonKey: "anon-key",
      supabaseUrl: "https://example.supabase.co",
    })();

    await expect(
      storage.profiles.runtime.getDownloadUrl(
        "supabase-storage://updates/assets/sha256/fi/file-hash.png",
        {},
      ),
    ).resolves.toEqual({
      fileUrl: "https://example.supabase.co/signed-url",
    });

    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(2);
  });

  it("does not retry signed URL generation for non-missing object errors", async () => {
    bucket.createSignedUrl.mockResolvedValueOnce({
      data: null,
      error: new Error("Storage API failed"),
    });

    const storage = supabaseStorage({
      bucketName: "updates",
      supabaseAnonKey: "anon-key",
      supabaseUrl: "https://example.supabase.co",
    })();

    await expect(
      storage.profiles.runtime.getDownloadUrl(
        "supabase-storage://updates/assets/sha256/fi/file-hash.png",
        {},
      ),
    ).rejects.toThrow(
      'Failed to generate download URL for "assets/sha256/fi/file-hash.png": Storage API failed',
    );

    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(1);
  });
});
