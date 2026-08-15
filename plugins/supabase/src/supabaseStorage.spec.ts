import { beforeEach, describe, expect, it, vi } from "vitest";

import { supabaseStorage } from "./supabaseStorage";

const { bucket, createClient } = vi.hoisted(() => {
  const bucket = {
    createSignedUrls: vi.fn(),
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
        body: new Response("bundle").body!,
        contentLength: 6,
        contentType: "application/zip",
      }),
    ).resolves.toEqual({
      storageUri: "supabase-storage://updates/bundles/bundle.zip",
    });
    expect(bucket.upload).toHaveBeenCalledWith(
      "bundles/bundle.zip",
      expect.any(ReadableStream),
      {
        cacheControl: "max-age=31536000",
        contentType: "application/zip",
        duplex: "half",
        headers: { "content-length": "6" },
      },
    );
  });

  it("round-trips reserved characters through exact Supabase object keys", async () => {
    const key = "릴리스 folder/#100%/bundle.zip";
    bucket.upload.mockResolvedValue({
      data: { fullPath: `updates/${key}` },
      error: null,
    });
    bucket.remove.mockResolvedValue({ data: [], error: null });

    const uploaded = await createStorage().put({
      key,
      body: new Response("bundle").body!,
      contentLength: 6,
      contentType: "application/zip",
    });
    expect(uploaded.storageUri).not.toContain("#100%");
    await createStorage().delete({ storageUri: uploaded.storageUri });

    expect(bucket.upload).toHaveBeenCalledWith(
      key,
      expect.any(ReadableStream),
      expect.any(Object),
    );
    expect(bucket.remove).toHaveBeenCalledWith([key]);
  });

  it("deletes exactly the referenced object", async () => {
    bucket.remove.mockResolvedValue({ error: null });

    await expect(
      createStorage().delete({
        storageUri: "supabase-storage://updates/releases/bundle.zip",
      }),
    ).resolves.toEqual({
      deleted: true,
    });

    expect(bucket.remove).toHaveBeenCalledWith(["releases/bundle.zip"]);
  });

  it("treats an already missing object as an idempotent delete", async () => {
    bucket.remove.mockResolvedValue({
      data: null,
      error: { message: "Object not found" },
    });
    const input = {
      storageUri: "supabase-storage://updates/releases/missing.zip",
    };

    await expect(createStorage().delete(input)).resolves.toEqual({
      deleted: true,
    });
    await expect(createStorage().delete(input)).resolves.toEqual({
      deleted: true,
    });
  });

  it("returns a Supabase signed download URL", async () => {
    bucket.createSignedUrls.mockResolvedValue({
      data: [
        {
          error: null,
          path: "assets/file-hash.png",
          signedUrl: "https://example.supabase.co/signed",
        },
      ],
      error: null,
    });

    await expect(
      createStorage().getDownloadUrl({
        storageUri: "supabase-storage://updates/assets/file-hash.png",
      }),
    ).resolves.toEqual({ url: "https://example.supabase.co/signed" });
    expect(bucket.createSignedUrls).toHaveBeenCalledWith(
      ["assets/file-hash.png"],
      3600,
    );
  });

  it("batches concurrent signed URL requests", async () => {
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
    const storage = createStorage();
    const paths = Array.from(
      { length: 20 },
      (_, index) => `assets/sha256/file-${index}.png`,
    );

    await expect(
      Promise.all(
        paths.map((key) =>
          storage.getDownloadUrl({
            storageUri: `supabase-storage://updates/${key}`,
          }),
        ),
      ),
    ).resolves.toEqual(
      paths.map((key) => ({
        url: `https://example.supabase.co/3600/${key}`,
      })),
    );
    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(bucket.createSignedUrls).toHaveBeenCalledWith(paths, 3600);
  });

  it("maps a batch item error to the matching request", async () => {
    bucket.createSignedUrls.mockResolvedValue({
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
    const storage = createStorage();

    const results = await Promise.allSettled([
      storage.getDownloadUrl({
        storageUri: "supabase-storage://updates/assets/available.png",
      }),
      storage.getDownloadUrl({
        storageUri: "supabase-storage://updates/assets/missing.png",
      }),
    ]);

    expect(results[0]).toEqual({
      status: "fulfilled",
      value: { url: "https://example.supabase.co/available.png" },
    });
    expect(results[1]).toEqual({
      status: "rejected",
      reason: new Error(
        'Failed to generate download URL for "assets/missing.png": Object not found',
      ),
    });
  });
});
