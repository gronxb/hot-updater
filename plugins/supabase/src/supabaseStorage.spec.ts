import { describe, expect, it, vi, beforeEach } from "vitest";

import { supabaseEdgeFunctionStorage } from "./supabaseEdgeFunctionStorage";
import { supabaseStorage } from "./supabaseStorage";

const mocks = vi.hoisted(() => ({
  bucket: {
    createSignedUrl: vi.fn(),
    getPublicUrl: vi.fn(),
  },
  from: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    storage: {
      from: mocks.from,
    },
  })),
}));

describe("supabaseStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockReturnValue(mocks.bucket);
    mocks.bucket.getPublicUrl.mockReturnValue({
      data: {
        publicUrl:
          "https://test.supabase.invalid/storage/v1/object/public/bundles/missing/index.ios.bundle",
      },
    });
  });

  it("falls back to a public URL when signing a missing full-asset fallback object", async () => {
    mocks.bucket.createSignedUrl.mockResolvedValue({
      data: null,
      error: {
        __isStorageError: true,
        message: "Object not found",
        name: "StorageApiError",
        status: 400,
        statusCode: "404",
      },
    });

    const plugin = supabaseStorage({
      supabaseUrl: "https://test.supabase.invalid",
      supabaseAnonKey: "test-anon-key",
      bucketName: "bundles",
    })();

    await expect(
      plugin.profiles.runtime.getDownloadUrl(
        "supabase-storage://bundles/release/files/__e2e_bspatch_full_asset_fallback_disabled__/index.ios.bundle",
      ),
    ).resolves.toEqual({
      fileUrl:
        "https://test.supabase.invalid/storage/v1/object/public/bundles/missing/index.ios.bundle",
    });
    expect(mocks.bucket.createSignedUrl).toHaveBeenCalledWith(
      "release/files/__e2e_bspatch_full_asset_fallback_disabled__/index.ios.bundle",
      3600,
    );
    expect(mocks.bucket.getPublicUrl).toHaveBeenCalledWith(
      "release/files/__e2e_bspatch_full_asset_fallback_disabled__/index.ios.bundle",
    );
  });

  it("falls back when Supabase returns an empty StorageApiError message for a missing object", async () => {
    mocks.bucket.createSignedUrl.mockResolvedValue({
      data: null,
      error: {
        __isStorageError: true,
        message: {},
        name: "StorageApiError",
      },
    });

    const plugin = supabaseStorage({
      supabaseUrl: "https://test.supabase.invalid",
      supabaseAnonKey: "test-anon-key",
      bucketName: "bundles",
    })();

    await expect(
      plugin.profiles.runtime.getDownloadUrl(
        "supabase-storage://bundles/release/files/__e2e_bspatch_full_asset_fallback_disabled__/index.ios.bundle",
      ),
    ).resolves.toEqual({
      fileUrl:
        "https://test.supabase.invalid/storage/v1/object/public/bundles/missing/index.ios.bundle",
    });
  });

  it("keeps non-missing signed URL failures visible", async () => {
    mocks.bucket.createSignedUrl.mockResolvedValue({
      data: null,
      error: {
        message: { error: "forbidden" },
        status: 403,
        statusCode: "403",
      },
    });

    const plugin = supabaseStorage({
      supabaseUrl: "https://test.supabase.invalid",
      supabaseAnonKey: "test-anon-key",
      bucketName: "bundles",
    })();

    await expect(
      plugin.profiles.runtime.getDownloadUrl(
        "supabase-storage://bundles/release/files/index.ios.bundle",
      ),
    ).rejects.toThrow('Failed to generate download URL: {"error":"forbidden"}');
  });
});

describe("supabaseEdgeFunctionStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockReturnValue(mocks.bucket);
    mocks.bucket.getPublicUrl.mockReturnValue({
      data: {
        publicUrl:
          "https://test.supabase.invalid/storage/v1/object/public/bundles/missing/index.ios.bundle",
      },
    });
  });

  it("uses the same missing-object fallback for edge runtime storage", async () => {
    mocks.bucket.createSignedUrl.mockResolvedValue({
      data: null,
      error: {
        message: "Object not found",
        name: "StorageApiError",
        status: 400,
        statusCode: "404",
      },
    });

    const plugin = supabaseEdgeFunctionStorage({
      supabaseUrl: "https://test.supabase.invalid",
      supabaseServiceRoleKey: "test-service-role-key",
    })();

    await expect(
      plugin.profiles.runtime.getDownloadUrl(
        "supabase-storage://bundles/release/files/__e2e_bspatch_full_asset_fallback_disabled__/index.ios.bundle",
      ),
    ).resolves.toEqual({
      fileUrl:
        "https://test.supabase.invalid/storage/v1/object/public/bundles/missing/index.ios.bundle",
    });
    expect(mocks.from).toHaveBeenCalledWith("bundles");
    expect(mocks.bucket.createSignedUrl).toHaveBeenCalledWith(
      "release/files/__e2e_bspatch_full_asset_fallback_disabled__/index.ios.bundle",
      3600,
    );
  });
});
