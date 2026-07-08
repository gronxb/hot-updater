import { assertRuntimeStorageOperations } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { supabaseEdgeFunctionStorage } from "./supabaseEdgeFunctionStorage";

const { bucket, createClient } = vi.hoisted(() => {
  const bucket = {
    createSignedUrl: vi.fn(),
    download: vi.fn(),
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

describe("supabaseEdgeFunctionStorage", () => {
  beforeEach(() => {
    bucket.createSignedUrl.mockReset();
    bucket.download.mockReset();
    createClient.mockClear();
  });

  it("surfaces signed URL generation errors", async () => {
    bucket.createSignedUrl.mockResolvedValueOnce({
      data: null,
      error: new Error("Object not found"),
    });

    const storage = supabaseEdgeFunctionStorage({
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.supabase.co",
    })();
    assertRuntimeStorageOperations(storage);

    await expect(
      storage.getDownloadUrl(
        "supabase-storage://updates/assets/sha256/fi/file-hash.png",
        {},
      ),
    ).rejects.toThrow(
      'Failed to generate download URL for "updates/assets/sha256/fi/file-hash.png": Object not found',
    );

    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(1);
    expect(bucket.createSignedUrl).toHaveBeenCalledWith(
      "assets/sha256/fi/file-hash.png",
      3600,
    );
  });

  it("surfaces thrown signed URL generation errors", async () => {
    bucket.createSignedUrl.mockRejectedValueOnce(
      new Error("Failed to generate download URL: Object not found"),
    );

    const storage = supabaseEdgeFunctionStorage({
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.supabase.co",
    })();
    assertRuntimeStorageOperations(storage);

    await expect(
      storage.getDownloadUrl(
        "supabase-storage://updates/assets/sha256/fi/file-hash.png",
        {},
      ),
    ).rejects.toThrow(
      'Failed to generate download URL for "updates/assets/sha256/fi/file-hash.png": Failed to generate download URL: Object not found',
    );

    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(1);
  });

  it("surfaces non-missing signed URL errors after one attempt", async () => {
    bucket.createSignedUrl.mockResolvedValueOnce({
      data: null,
      error: new Error("Storage API failed"),
    });

    const storage = supabaseEdgeFunctionStorage({
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.supabase.co",
    })();
    assertRuntimeStorageOperations(storage);

    await expect(
      storage.getDownloadUrl(
        "supabase-storage://updates/assets/sha256/fi/file-hash.png",
        {},
      ),
    ).rejects.toThrow(
      'Failed to generate download URL for "updates/assets/sha256/fi/file-hash.png": Storage API failed',
    );

    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(1);
  });
});
