import {
  createStorageDownloadPath,
  createStoragePlugin,
  MAX_BUNDLE_MANIFEST_BYTES,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStorageAccess } from "./storageAccess";

describe("createStorageAccess", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads text through a matching storage implementation", async () => {
    const get = vi.fn(
      async (_storageUri: string) => new Response("manifest text"),
    );
    const storage = createStoragePlugin({
      name: "r2Storage",
      protocol: "r2",
      get: async (input) => ({ response: await get(input.storageUri) }),
    });
    const { readStorageText } = createStorageAccess([storage]);

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
    const { readStorageText } = createStorageAccess([]);

    await expect(
      readStorageText("https://assets.example.com/manifest.json"),
    ).resolves.toBe("manifest text");
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: {
        "content-length": String(MAX_BUNDLE_MANIFEST_BYTES + 1),
      },
    });
    const storage = createStoragePlugin({
      name: "r2Storage",
      protocol: "r2",
      get: async () => ({ response }),
    });
    const { readStorageText } = createStorageAccess([storage]);

    await expect(readStorageText("r2://assets/manifest.json")).rejects.toThrow(
      "byte limit",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("counts headerless response chunks and cancels after the limit", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(Math.ceil(MAX_BUNDLE_MANIFEST_BYTES / 2));
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.enqueue(new Uint8Array([1]));
        },
        cancel,
      }),
    );
    const storage = createStoragePlugin({
      name: "r2Storage",
      protocol: "r2",
      get: async () => ({ response }),
    });
    const { readStorageText } = createStorageAccess([storage]);

    await expect(readStorageText("r2://assets/manifest.json")).rejects.toThrow(
      "byte limit",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses an unowned HTTPS URI directly as the download URL", async () => {
    const { resolveFileUrl } = createStorageAccess([]);
    const storageUri = "https://assets.example.com/bundle.zip";

    await expect(resolveFileUrl(storageUri)).resolves.toBe(storageUri);
  });

  it.each([
    "https://user:pass@assets.example.com/bundle.zip",
    "https://assets.example.com:99999/bundle.zip",
    "https://assets.example.com\\bundle.zip",
    "https://assets.example.com/bundle.zip\nignored",
  ])("rejects an unsafe direct HTTP storage URL: %s", async (storageUri) => {
    const { resolveFileUrl } = createStorageAccess([]);

    await expect(resolveFileUrl(storageUri)).rejects.toThrow("safe HTTP(S)");
  });

  it("lets a matching HTTPS storage own reads before direct fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const get = vi.fn(
      async () => ({ response: new Response("owned manifest") }) as const,
    );
    const storage = createStoragePlugin({
      name: "standaloneStorage",
      protocol: "https",
      get,
    });
    const { readStorageText } = createStorageAccess([storage]);
    const storageUri = "https://storage.example.com/manifest.json";

    await expect(readStorageText(storageUri)).resolves.toBe("owned manifest");
    expect(get).toHaveBeenCalledWith({ storageUri });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a matching HTTPS storage resolve the download URL", async () => {
    const getDownloadUrl = vi.fn(async () => ({
      url: "https://cdn.example.com/bundle.zip",
    }));
    const storage = createStoragePlugin({
      name: "standaloneStorage",
      protocol: "https",
      get: async () => ({ response: null }),
      getDownloadUrl,
    });
    const { resolveFileUrl } = createStorageAccess([storage]);
    const storageUri = "https://storage.example.com/bundle.zip";

    await expect(resolveFileUrl(storageUri)).resolves.toBe(
      "https://cdn.example.com/bundle.zip",
    );
    expect(getDownloadUrl).toHaveBeenCalledWith({ storageUri });
  });

  it("rejects a credentialed URL returned by a storage plugin", async () => {
    const storage = createStoragePlugin({
      name: "standaloneStorage",
      protocol: "https",
      get: async () => ({ response: null }),
      getDownloadUrl: async () => ({
        url: "https://user:pass@cdn.example.com/bundle.zip",
      }),
    });
    const { resolveFileUrl } = createStorageAccess([storage]);

    await expect(
      resolveFileUrl("https://storage.example.com/bundle.zip"),
    ).rejects.toThrow("safe HTTP(S)");
  });

  it("creates and serves a runtime-neutral delivery URL", async () => {
    const storage = createStoragePlugin({
      name: "r2Storage",
      protocol: "r2",
      get: vi.fn(
        async () =>
          ({
            response: new Response("bundle", {
              headers: { "content-type": "application/zip" },
            }),
          }) as const,
      ),
      getDownloadUrl: async ({ storageUri }) => ({
        url: createStorageDownloadPath(storageUri, "test-signature"),
      }),
    });
    const access = createStorageAccess([storage]);

    const fileUrl = await access.resolveFileUrl("r2://bucket/bundle.zip");
    expect(fileUrl).toMatch(/^\/storage\//);
    const segments = fileUrl!.split("/");
    const token = segments.at(-2)!;
    const signature = segments.at(-1)!;
    const response = await access.downloadStorageObject!(token, signature);
    await expect(response?.text()).resolves.toBe("bundle");
    await expect(
      access.downloadStorageObject!(token, `${signature}tampered`),
    ).resolves.toBeNull();
  });

  it("lets a CDN resolver bypass built-in server delivery", async () => {
    const resolveUrl = vi.fn(async () => ({
      url: "https://cdn.example.com/bundle.zip",
    }));
    const storage = createStoragePlugin({
      name: "s3Storage",
      protocol: "s3",
      get: async () => ({ response: null }),
      getDownloadUrl: resolveUrl,
    });
    const access = createStorageAccess([storage]);

    await expect(access.resolveFileUrl("s3://bucket/bundle.zip")).resolves.toBe(
      "https://cdn.example.com/bundle.zip",
    );
    expect(access.downloadStorageObject).toEqual(expect.any(Function));
  });

  it("rejects ambiguous storage protocol ownership", () => {
    const first = createStoragePlugin({
      name: "firstR2Storage",
      protocol: "r2",
      get: async () => ({ response: null }),
    });
    const second = createStoragePlugin({
      name: "secondR2Storage",
      protocol: "r2",
      get: async () => ({ response: null }),
    });

    expect(() => createStorageAccess([first, second])).toThrow(
      "Multiple storage plugins handle protocol: r2",
    );
  });
});
