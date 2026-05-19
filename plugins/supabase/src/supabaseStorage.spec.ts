import { beforeEach, describe, expect, it, vi } from "vitest";

import { supabaseStorage } from "./supabaseStorage";

const { bucket, createClient } = vi.hoisted(() => {
  const bucket = {
    exists: vi.fn(),
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
    bucket.exists.mockReset();
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
});
