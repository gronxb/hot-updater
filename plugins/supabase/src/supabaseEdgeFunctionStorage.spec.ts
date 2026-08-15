import { beforeEach, describe, expect, it, vi } from "vitest";

import { supabaseEdgeFunctionStorage } from "./supabaseEdgeFunctionStorage";

const { bucket, createClient, from } = vi.hoisted(() => {
  const bucket = {
    createSignedUrls: vi.fn(),
    download: vi.fn(),
  };
  const from = vi.fn(() => bucket);

  return {
    bucket,
    createClient: vi.fn(() => ({
      storage: {
        from,
      },
    })),
    from,
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient,
}));

describe("supabaseEdgeFunctionStorage", () => {
  beforeEach(() => {
    bucket.createSignedUrls.mockReset();
    bucket.download.mockReset();
    createClient.mockClear();
    from.mockClear();
  });

  it("batches concurrent signed URL requests for a bucket", async () => {
    bucket.createSignedUrls.mockImplementation(
      async (paths: string[], expiresIn: number) => ({
        data: paths.map((path) => ({
          error: null,
          path,
          signedUrl: `https://example.supabase.co/${expiresIn}/${path}`,
        })),
        error: null,
      }),
    );

    const storage = supabaseEdgeFunctionStorage({
      signedUrlExpiresIn: 600,
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.supabase.co",
    })();
    const paths = Array.from(
      { length: 20 },
      (_, index) => `assets/sha256/file-${index}.png`,
    );

    await expect(
      Promise.all(
        paths.map((path) =>
          storage.profiles.runtime.getDownloadUrl(
            `supabase-storage://updates/${path}`,
          ),
        ),
      ),
    ).resolves.toEqual(
      paths.map((path) => ({
        fileUrl: `https://example.supabase.co/600/${path}`,
      })),
    );

    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(bucket.createSignedUrls).toHaveBeenCalledWith(paths, 600);
    expect(from).toHaveBeenCalledWith("updates");
  });

  it("keeps signed URL batches separated by bucket", async () => {
    bucket.createSignedUrls.mockImplementation(async (paths: string[]) => ({
      data: paths.map((path) => ({
        error: null,
        path,
        signedUrl: `https://example.supabase.co/${path}`,
      })),
      error: null,
    }));

    const storage = supabaseEdgeFunctionStorage({
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.supabase.co",
    })();

    await Promise.all([
      storage.profiles.runtime.getDownloadUrl(
        "supabase-storage://updates/assets/update.png",
      ),
      storage.profiles.runtime.getDownloadUrl(
        "supabase-storage://previews/assets/preview.png",
      ),
    ]);

    expect(from.mock.calls).toEqual([["updates"], ["previews"]]);
    expect(bucket.createSignedUrls.mock.calls).toEqual([
      [["assets/update.png"], 3600],
      [["assets/preview.png"], 3600],
    ]);
  });

  it("maps per-object batch errors to the matching request", async () => {
    bucket.createSignedUrls.mockResolvedValueOnce({
      data: [
        {
          error: null,
          path: "assets/available.png",
          signedUrl: "https://example.supabase.co/available.png",
        },
        {
          error: "Object not found",
          path: "assets/missing.png",
          signedUrl: "",
        },
      ],
      error: null,
    });

    const storage = supabaseEdgeFunctionStorage({
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.supabase.co",
    })();

    const results = await Promise.allSettled([
      storage.profiles.runtime.getDownloadUrl(
        "supabase-storage://updates/assets/available.png",
      ),
      storage.profiles.runtime.getDownloadUrl(
        "supabase-storage://updates/assets/missing.png",
      ),
    ]);

    expect(results[0]).toEqual({
      status: "fulfilled",
      value: { fileUrl: "https://example.supabase.co/available.png" },
    });
    expect(results[1]).toEqual({
      status: "rejected",
      reason: new Error(
        'Failed to generate download URL for "updates/assets/missing.png": Object not found',
      ),
    });
    expect(bucket.createSignedUrls).toHaveBeenCalledWith(
      ["assets/available.png", "assets/missing.png"],
      3600,
    );
  });

  it("surfaces signed URL generation errors", async () => {
    bucket.createSignedUrls.mockResolvedValueOnce({
      data: null,
      error: new Error("Object not found"),
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
      'Failed to generate download URL for "updates/assets/sha256/fi/file-hash.png": Object not found',
    );

    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(bucket.createSignedUrls).toHaveBeenCalledWith(
      ["assets/sha256/fi/file-hash.png"],
      3600,
    );
  });

  it("surfaces thrown signed URL generation errors", async () => {
    bucket.createSignedUrls.mockRejectedValueOnce(
      new Error("Failed to generate download URL: Object not found"),
    );

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
      'Failed to generate download URL for "updates/assets/sha256/fi/file-hash.png": Failed to generate download URL: Object not found',
    );

    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(1);
  });

  it("surfaces non-missing signed URL errors after one attempt", async () => {
    bucket.createSignedUrls.mockResolvedValueOnce({
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

    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(1);
  });
});
