import type { RuntimeStoragePlugin } from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStorageAccess } from "./storageAccess";

describe("createStorageAccess", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads text through a matching runtime storage plugin before direct HTTP fetch", async () => {
    const readText = vi.fn(async () => "manifest text");
    const storagePlugin: RuntimeStoragePlugin = {
      name: "httpStorage",
      supportedProtocol: "http",
      profiles: {
        runtime: {
          readText,
          async getDownloadUrl(storageUri) {
            return { fileUrl: storageUri };
          },
        },
      },
    };
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("should not be used", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { readStorageText } = createStorageAccess([storagePlugin]);

    await expect(
      readStorageText("http://assets.example.com/manifest.json"),
    ).resolves.toBe("manifest text");
    expect(readText).toHaveBeenCalledWith(
      "http://assets.example.com/manifest.json",
      undefined,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads direct HTTP storage text when no storage plugin owns the protocol", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("manifest text", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { readStorageText } = createStorageAccess([]);

    await expect(
      readStorageText("https://assets.example.com/manifest.json"),
    ).resolves.toBe("manifest text");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://assets.example.com/manifest.json",
    );
  });

  it("uses direct HTTPS fallback when only the HTTP protocol is registered", async () => {
    const readText = vi.fn(async () => "plugin");
    const storagePlugin = createRuntimeStoragePlugin(
      "standaloneStorage",
      "http",
      {
        readText,
      },
    );
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("direct", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { readStorageText } = createStorageAccess([storagePlugin]);

    await expect(
      readStorageText("https://assets.example.com/manifest.json"),
    ).resolves.toBe("direct");
    expect(readText).not.toHaveBeenCalled();
  });

  it("uses an explicitly registered HTTPS plugin before direct fetch", async () => {
    const readText = vi.fn(async () => "plugin");
    const storagePlugin = createRuntimeStoragePlugin("httpsStorage", "https", {
      readText,
    });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const { readStorageText } = createStorageAccess([storagePlugin]);

    await expect(
      readStorageText("https://assets.example.com/manifest.json"),
    ).resolves.toBe("plugin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate normalized protocols before the first storage operation", () => {
    const firstRead = vi.fn(async () => "first");
    const secondRead = vi.fn(async () => "second");
    const first = createRuntimeStoragePlugin("standaloneStorage", "HTTP", {
      readText: firstRead,
    });
    const second = createRuntimeStoragePlugin("proxyStorage", "http", {
      readText: secondRead,
    });

    expect(() => createStorageAccess([first, second])).toThrow(
      'Duplicate storage protocol "http" from plugins "standaloneStorage" and "proxyStorage".',
    );
    expect(firstRead).not.toHaveBeenCalled();
    expect(secondRead).not.toHaveBeenCalled();
  });

  it("rejects malformed storage URIs deterministically", async () => {
    const { readStorageText } = createStorageAccess([]);

    await expect(readStorageText("not a storage URI")).rejects.toThrow(
      "Invalid storage URI: not a storage URI",
    );
  });

  it("rejects storage URIs owned by an unregistered provider", async () => {
    const storagePlugin = createRuntimeStoragePlugin("r2Storage", "r2");
    const { readStorageText } = createStorageAccess([storagePlugin]);

    await expect(
      readStorageText("s3://release-bucket/updates/bundle.zip"),
    ).rejects.toThrow("No storage plugin for protocol: s3");
  });
});

const createRuntimeStoragePlugin = (
  name: string,
  supportedProtocol: string,
  overrides: Partial<RuntimeStoragePlugin["profiles"]["runtime"]> = {},
): RuntimeStoragePlugin => ({
  name,
  supportedProtocol,
  profiles: {
    runtime: {
      async getDownloadUrl(storageUri) {
        return { fileUrl: storageUri };
      },
      async readText() {
        return null;
      },
      ...overrides,
    },
  },
});
