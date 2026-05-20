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

    const storage = supabaseEdgeFunctionStorage({
      supabaseServiceRoleKey: "service-role-key",
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

  it("retries signed URL generation when Supabase throws a missing object error", async () => {
    bucket.createSignedUrl
      .mockRejectedValueOnce(
        new Error("Failed to generate download URL: Object not found"),
      )
      .mockResolvedValueOnce({
        data: { signedUrl: "https://example.supabase.co/signed-url" },
        error: null,
      });

    const storage = supabaseEdgeFunctionStorage({
      supabaseServiceRoleKey: "service-role-key",
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

    const storage = supabaseEdgeFunctionStorage({
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.supabase.co",
    })();

    await expect(
      storage.profiles.runtime.getDownloadUrl(
        "supabase-storage://updates/assets/sha256/fi/file-hash.png",
        {},
      ),
    ).rejects.toThrow(
      'Failed to generate download URL for "updates/assets/sha256/fi/file-hash.png": Storage API failed',
    );

    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(1);
  });
});
