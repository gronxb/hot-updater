import { beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  head: vi.fn(),
  issueSignedToken: vi.fn(),
  list: vi.fn(),
  presignUrl: vi.fn(),
  put: vi.fn(),
  BlobNotFoundError: class BlobNotFoundError extends Error {},
}));
vi.mock("@vercel/blob", () => blob);

import { vercelBlobStorage } from "./vercelBlobStorage";

const token = "vercel_blob_rw_AbC123_secret";

beforeEach(() => {
  vi.clearAllMocks();
  blob.issueSignedToken.mockImplementation(
    async ({ validUntil }: { validUntil: number }) => ({
      clientSigningToken: "signing",
      delegationToken: "delegation",
      validUntil,
    }),
  );
  blob.presignUrl.mockImplementation(
    async (_token: unknown, { pathname }: { pathname: string }) => ({
      presignedUrl: `https://abc123.private.blob.vercel-storage.com/${pathname}?signed`,
    }),
  );
});

describe("vercelBlobStorage", () => {
  it("rejects a token that is not a store's read-write token", () => {
    expect(() =>
      vercelBlobStorage({ access: "private", token: "vercel_blob_client_x" }),
    ).toThrow("read-write token");
  });

  it("rejects a download URL lifetime beyond Vercel's seven days", () => {
    for (const signedUrlExpiresIn of [0, 604_801, Number.NaN]) {
      expect(() =>
        vercelBlobStorage({ access: "private", signedUrlExpiresIn, token }),
      ).toThrow("seven days");
    }
  });

  it("keeps a delegation within seven days for week-long URLs", async () => {
    const storage = vercelBlobStorage({
      access: "private",
      signedUrlExpiresIn: 604_800,
      token,
    });
    const before = Date.now();

    await storage.getDownloadUrl({
      storageUri: "vercel-blob://store_AbC123/a.txt",
    });

    const [{ validUntil }] = blob.issueSignedToken.mock.calls[0] as [
      { validUntil: number },
    ];
    expect(validUntil - before).toBeLessThanOrEqual(604_800_000 + 1_000);
  });

  it("keeps a key in the store the token belongs to", async () => {
    const storage = vercelBlobStorage({
      access: "private",
      basePath: "ota",
      token,
    });

    const { storageUri } = await storage.put({
      body: new Blob(["bundle"]).stream(),
      contentLength: 6,
      contentType: "application/octet-stream",
      key: "bundle/manifest.json",
    });

    expect(storageUri).toBe(
      "vercel-blob://store_AbC123/ota/bundle/manifest.json",
    );
    expect(blob.put).toHaveBeenCalledWith(
      "ota/bundle/manifest.json",
      expect.any(ReadableStream),
      expect.objectContaining({
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        multipart: false,
        token,
      }),
    );
  });

  it("uploads a body of unknown length in parts", async () => {
    const storage = vercelBlobStorage({ access: "private", token });

    await storage.put({
      body: new Blob(["bundle"]).stream(),
      contentType: "application/octet-stream",
      key: "bundle.tar.br",
    });

    expect(blob.put).toHaveBeenCalledWith(
      "bundle.tar.br",
      expect.any(ReadableStream),
      expect.objectContaining({ multipart: true }),
    );
  });

  it("refuses a URI of another store", async () => {
    const storage = vercelBlobStorage({ access: "private", token });

    await expect(
      storage.getDownloadUrl({ storageUri: "vercel-blob://store_other/a.txt" }),
    ).rejects.toThrow('expected "store_AbC123"');
  });

  it("presigns private download URLs from one delegation", async () => {
    const storage = vercelBlobStorage({ access: "private", token });

    const first = await storage.getDownloadUrl({
      storageUri: "vercel-blob://store_AbC123/a.txt",
    });
    await storage.getDownloadUrl({
      storageUri: "vercel-blob://store_AbC123/b.txt",
    });

    expect(first.url).toBe(
      "https://abc123.private.blob.vercel-storage.com/a.txt?signed",
    );
    expect(blob.issueSignedToken).toHaveBeenCalledTimes(1);
    expect(blob.issueSignedToken).toHaveBeenCalledWith(
      expect.objectContaining({ operations: ["get"], token }),
    );
    expect(blob.presignUrl).toHaveBeenCalledWith(
      expect.objectContaining({ delegationToken: "delegation" }),
      expect.objectContaining({
        access: "private",
        operation: "get",
        pathname: "a.txt",
      }),
    );
  });

  it("issues a new delegation once the current one ends before a URL would", async () => {
    vi.useFakeTimers();
    try {
      const storage = vercelBlobStorage({ access: "private", token });
      await storage.getDownloadUrl({
        storageUri: "vercel-blob://store_AbC123/a.txt",
      });
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      await storage.getDownloadUrl({
        storageUri: "vercel-blob://store_AbC123/a.txt",
      });

      expect(blob.issueSignedToken).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("issues a delegation again after one fails", async () => {
    blob.issueSignedToken.mockRejectedValueOnce(new Error("unavailable"));
    const storage = vercelBlobStorage({ access: "private", token });

    await expect(
      storage.getDownloadUrl({
        storageUri: "vercel-blob://store_AbC123/a.txt",
      }),
    ).rejects.toThrow("unavailable");
    await storage.getDownloadUrl({
      storageUri: "vercel-blob://store_AbC123/a.txt",
    });

    expect(blob.issueSignedToken).toHaveBeenCalledTimes(2);
  });

  it("downloads a public store's objects from their Blob URL", async () => {
    const storage = vercelBlobStorage({ access: "public", token });

    const { url } = await storage.getDownloadUrl({
      storageUri: "vercel-blob://store_AbC123/with%20space/hash%231.txt",
    });

    expect(url).toBe(
      "https://abc123.public.blob.vercel-storage.com/with%20space/hash!231.txt",
    );
    expect(blob.issueSignedToken).not.toHaveBeenCalled();
  });

  it("lists only the pathnames it stores keys under", async () => {
    blob.list.mockResolvedValueOnce({
      blobs: [
        { pathname: "ota/a!231.txt", size: 1, uploadedAt: new Date(0) },
        { pathname: "ota/raw#hash.txt", size: 1, uploadedAt: new Date(0) },
        { pathname: "ota/bad!zz.txt", size: 1, uploadedAt: new Date(0) },
      ],
      hasMore: false,
    });
    const storage = vercelBlobStorage({
      access: "private",
      basePath: "ota",
      token,
    });

    const objects = await storage.listObjects();

    expect(objects.map(({ key, storageUri }) => ({ key, storageUri }))).toEqual(
      [
        {
          key: "a#1.txt",
          storageUri: "vercel-blob://store_AbC123/ota/a%231.txt",
        },
      ],
    );
    expect(blob.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000, prefix: "ota/", token }),
    );
  });

  it("forwards the content length only of an unencoded download", async () => {
    const storage = vercelBlobStorage({ access: "private", token });
    blob.get.mockResolvedValueOnce({
      statusCode: 200,
      stream: new Blob(["abc"]).stream(),
      headers: new Headers({
        "content-encoding": "br",
        "content-length": "2",
      }),
      blob: { contentType: "text/plain", size: 0 },
    });

    const { response } = await storage.get({
      storageUri: "vercel-blob://store_AbC123/a.txt",
    });

    expect(response?.headers.get("content-length")).toBeNull();
    expect(await response?.text()).toBe("abc");
  });
});
