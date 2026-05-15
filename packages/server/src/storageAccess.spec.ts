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
});
