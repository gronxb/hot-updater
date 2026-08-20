import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(
  () => ({}) as Record<string, ReturnType<typeof vi.fn>>,
);

vi.mock("./specs/NativeHotUpdater", () => ({ default: nativeModule }));

import { fetchReleaseCatalogWithCache } from "./releaseCatalogCache";

const authorityId = "project-a";
const scopeKey = createReleaseCatalogScopeKey({
  authorityId,
  channelKey: encodeChannelKey("production"),
  platform: "ios",
  strategy: "APP_VERSION",
});
const input = {
  authorityId,
  baseURL: "https://updates.example.com",
  requestHeaders: { "x-api-key": "key" },
  scopeKey,
  url: "https://updates.example.com/catalog",
};
const catalog: ReleaseCatalog = {
  authorityId,
  catalogHash: `sha256:${"a".repeat(64)}`,
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  generation: 1,
  releases: [],
  schemaVersion: 1,
  scopeKey,
};

describe("Release Catalog native cache contract", () => {
  beforeEach(() => {
    for (const key of Object.keys(nativeModule)) delete nativeModule[key];
  });

  it("fails before fetching when the v1 native cache API is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReleaseCatalogWithCache(input)).rejects.toThrow(
      "Native module is missing 'getReleaseCatalogCache()'. Rebuild the native app before using Release catalogs.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the network when native cache I/O fails", async () => {
    nativeModule.getReleaseCatalogCache = vi
      .fn()
      .mockRejectedValue(new Error("read"));
    nativeModule.setReleaseCatalogCache = vi
      .fn()
      .mockRejectedValue(new Error("write"));
    nativeModule.removeReleaseCatalogCache = vi
      .fn()
      .mockRejectedValue(new Error("remove"));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(catalog), {
        headers: { ETag: '"v1"' },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReleaseCatalogWithCache(input)).resolves.toEqual(catalog);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(nativeModule.getReleaseCatalogCache).toHaveBeenCalledOnce();
    expect(nativeModule.setReleaseCatalogCache).toHaveBeenCalledOnce();
  });
});
