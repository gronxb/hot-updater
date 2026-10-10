import { createStorageAdapter } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStorageAccess } from "./storageAccess";

/** Storage that owns `s3://`, so an `https://` URI is nobody's. */
const s3Storage = () =>
  createStorageAdapter({ name: "s3Storage", protocol: "s3" });

describe("createStorageAccess", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads text through a matching storage implementation", async () => {
    const get = vi.fn(
      async (_storageUri: string) => new Response("manifest text"),
    );
    const storage = createStorageAdapter({
      name: "r2Storage",
      protocol: "r2",
      get: async (input) => ({ response: await get(input.storageUri) }),
    });
    const { readStorageText } = createStorageAccess(storage);

    await expect(readStorageText("r2://assets/manifest.json")).resolves.toBe(
      "manifest text",
    );
    expect(get).toHaveBeenCalledWith("r2://assets/manifest.json");
  });

  it("reads direct HTTP storage when no plugin owns the protocol", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("manifest text"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { readStorageText } = createStorageAccess(s3Storage());

    await expect(
      readStorageText("https://assets.example.com/manifest.json"),
    ).resolves.toBe("manifest text");
  });

  it("uses an unowned HTTPS URI directly as the download URL", async () => {
    const { resolveFileUrl } = createStorageAccess(s3Storage());
    const storageUri = "https://assets.example.com/bundle.zip";

    await expect(resolveFileUrl(storageUri)).resolves.toBe(storageUri);
  });

  it("lets a matching HTTPS storage own reads before direct fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const get = vi.fn(
      async () => ({ response: new Response("owned manifest") }) as const,
    );
    const storage = createStorageAdapter({
      name: "standaloneStorage",
      protocol: "https",
      get,
    });
    const { readStorageText } = createStorageAccess(storage);
    const storageUri = "https://storage.example.com/manifest.json";

    await expect(readStorageText(storageUri)).resolves.toBe("owned manifest");
    expect(get).toHaveBeenCalledWith({ storageUri });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a matching HTTPS storage resolve the download URL", async () => {
    const getDownloadUrl = vi.fn(async () => ({
      url: "https://cdn.example.com/bundle.zip",
    }));
    const storage = createStorageAdapter({
      name: "standaloneStorage",
      protocol: "https",
      get: async () => ({ response: null }),
      getDownloadUrl,
    });
    const { resolveFileUrl } = createStorageAccess(storage);
    const storageUri = "https://storage.example.com/bundle.zip";

    await expect(resolveFileUrl(storageUri)).resolves.toBe(
      "https://cdn.example.com/bundle.zip",
    );
    expect(getDownloadUrl).toHaveBeenCalledWith({ storageUri });
  });

  it("refuses a download URL that is not an absolute HTTP(S) URL", async () => {
    for (const url of ["/storage/token/signature", "r2://bucket/bundle.zip"]) {
      const storage = createStorageAdapter({
        name: "r2Storage",
        protocol: "r2",
        get: async () => ({ response: null }),
        getDownloadUrl: async () => ({ url }),
      });
      const { resolveFileUrl } = createStorageAccess(storage);

      await expect(resolveFileUrl("r2://bucket/bundle.zip")).rejects.toThrow(
        "Storage getDownloadUrl must resolve to an absolute HTTP(S) URL.",
      );
    }
  });

  it("refuses a URI of a protocol other than the storage's", async () => {
    const storage = createStorageAdapter({
      name: "r2Storage",
      protocol: "r2",
      get: async () => ({ response: null }),
    });
    const { readStorageText } = createStorageAccess(storage);

    await expect(readStorageText("s3://bucket/manifest.json")).rejects.toThrow(
      "No storage adapter for protocol: s3",
    );
  });
});
