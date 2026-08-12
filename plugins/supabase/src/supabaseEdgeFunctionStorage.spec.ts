import { describe, expect, it, vi } from "vitest";

import { supabaseEdgeFunctionStorage } from "./supabaseEdgeFunctionStorage";

const { bucket, createClient } = vi.hoisted(() => {
  const bucket = { download: vi.fn() };
  return {
    bucket,
    createClient: vi.fn(() => ({
      storage: { from: vi.fn(() => bucket) },
    })),
  };
});

vi.mock("@supabase/supabase-js", () => ({ createClient }));

describe("supabaseEdgeFunctionStorage", () => {
  it("uses the same flat Response contract with edge credentials", async () => {
    bucket.download.mockResolvedValue({
      data: new Blob(["manifest"]),
      error: null,
    });
    const storage = supabaseEdgeFunctionStorage({
      bucketName: "updates",
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.supabase.co",
    });

    const response = await storage.get(
      "supabase-storage://updates/manifest.json",
    );

    await expect(response?.text()).resolves.toBe("manifest");
    expect(createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-key",
    );
  });
});
