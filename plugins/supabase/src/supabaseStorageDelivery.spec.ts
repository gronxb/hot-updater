import { describe, expect, it, vi } from "vitest";

import { supabaseStorageDelivery } from "./supabaseStorageDelivery";

const { bucket, createClient } = vi.hoisted(() => {
  const bucket = { createSignedUrl: vi.fn() };
  return {
    bucket,
    createClient: vi.fn(() => ({
      storage: { from: vi.fn(() => bucket) },
    })),
  };
});

vi.mock("@supabase/supabase-js", () => ({ createClient }));

describe("supabaseStorageDelivery", () => {
  it("resolves signed URLs outside the storage plugin contract", async () => {
    bucket.createSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://example.supabase.co/signed" },
      error: null,
    });
    const delivery = supabaseStorageDelivery({
      bucketName: "updates",
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.supabase.co",
    });

    await expect(
      delivery.resolveUrl("supabase-storage://updates/assets/file-hash.png"),
    ).resolves.toBe("https://example.supabase.co/signed");
    expect(bucket.createSignedUrl).toHaveBeenCalledWith(
      "assets/file-hash.png",
      3600,
    );
  });
});
