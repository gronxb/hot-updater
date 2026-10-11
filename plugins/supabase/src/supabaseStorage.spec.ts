import { parseStorageUri } from "@hot-updater/plugin-core";
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
      supabaseServiceRoleKey: "service-role-key",
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

  it("maps the Supabase missing-object HEAD response to false", async () => {
    bucket.exists.mockResolvedValue({
      data: false,
      error: Object.assign(new Error("{}"), {
        name: "StorageUnknownError",
        originalError: { status: 400 },
      }),
    });

    await expect(
      createStorage().exists({
        storageUri: "supabase-storage://updates/assets/missing.png",
      }),
    ).resolves.toEqual({ exists: false });
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

  it("reads with the service role key under the decoded object name", async () => {
    bucket.download.mockResolvedValue({
      data: new Blob(["manifest"]),
      error: null,
    });

    const { response } = await createStorage().get({
      storageUri: "supabase-storage://updates/logo%402x.json",
    });

    await expect(response?.text()).resolves.toBe("manifest");
    expect(createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-key",
    );
    expect(bucket.download).toHaveBeenCalledWith("logo@2x.json");
  });

  /** supabase-js's error for a download Storage answered with `body`. */
  const downloadError = (body: object) =>
    Object.assign(new Error("{}"), {
      name: "StorageUnknownError",
      originalError: new Response(JSON.stringify(body), { status: 400 }),
    });

  it("reads a missing object as a null response", async () => {
    bucket.download.mockResolvedValue({
      data: null,
      error: downloadError({
        statusCode: "404",
        error: "not_found",
        message: "Object not found",
      }),
    });

    await expect(
      createStorage().get({
        storageUri: "supabase-storage://updates/bundles/missing.json",
      }),
    ).resolves.toEqual({ response: null });
  });

  it("does not read a missing bucket as a missing object", async () => {
    bucket.download.mockResolvedValue({
      data: null,
      error: downloadError({
        statusCode: "404",
        error: "Bucket not found",
        message: "Bucket not found",
      }),
    });

    await expect(
      createStorage().get({
        storageUri: "supabase-storage://updates/bundles/manifest.json",
      }),
    ).rejects.toThrow("Failed to download storage object");
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
        upsert: true,
        duplex: "half",
        headers: { "content-length": "6" },
      },
    );
  });

  it("allows concurrent deployments to upload the same shared asset", async () => {
    const objects = new Set<string>();
    bucket.upload.mockImplementation(async (key, _body, options) => {
      if (objects.has(key) && !options.upsert) {
        return { error: new Error("The resource already exists") };
      }
      objects.add(key);
      return { error: null };
    });
    const storage = createStorage();
    const upload = () =>
      storage.put({
        key: "assets/sha256/ab/shared.png",
        body: new Response("shared asset").body!,
        contentType: "image/png",
      });

    const results = await Promise.all([upload(), upload()]);

    expect(objects.size).toBe(1);
    expect(results[0].storageUri).toBe(results[1].storageUri);
    expect(bucket.upload).toHaveBeenCalledTimes(2);
  });

  it("stores characters Storage rejects, `?` and `!` under escaped object names", async () => {
    bucket.upload.mockResolvedValue({ data: {}, error: null });
    bucket.remove.mockResolvedValue({ data: [], error: null });
    const names = new Map([
      [
        "릴리스 folder/logo@2x #100%/bundle.zip",
        "!EB!A6!B4!EB!A6!AC!EC!8A!A4 folder/logo@2x !23100!25/bundle.zip",
      ],
      ["releases/what?.zip", "releases/what!3F.zip"],
      ["releases/wow!.zip", "releases/wow!21.zip"],
      ["releases/wow!21.zip", "releases/wow!2121.zip"],
      [
        "releases/1.0.0/(a)_b+c,d;e=f&g$h'i*j:k-l.zip",
        "releases/1.0.0/(a)_b+c,d;e=f&g$h'i*j:k-l.zip",
      ],
    ]);

    for (const [key, name] of names) {
      const uploaded = await createStorage().put({
        key,
        body: new Response("bundle").body!,
        contentLength: 6,
        contentType: "application/zip",
      });
      // The URI keeps the key.
      expect(parseStorageUri(uploaded.storageUri, "supabase-storage").key).toBe(
        key,
      );
      await createStorage().delete({ storageUri: uploaded.storageUri });

      expect(bucket.upload).toHaveBeenLastCalledWith(
        name,
        expect.any(ReadableStream),
        expect.any(Object),
      );
      expect(bucket.remove).toHaveBeenLastCalledWith([name]);
    }
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
          path: "assets/logo@2x.png",
          signedUrl: "https://example.supabase.co/signed",
        },
      ],
      error: null,
    });

    await expect(
      createStorage().getDownloadUrl({
        storageUri: "supabase-storage://updates/assets/logo%402x.png",
      }),
    ).resolves.toEqual({ url: "https://example.supabase.co/signed" });
    expect(bucket.createSignedUrls).toHaveBeenCalledWith(
      ["assets/logo@2x.png"],
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
