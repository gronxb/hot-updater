import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultResolver } from "./DefaultResolver";

const mocks = vi.hoisted(() => {
  (
    globalThis as typeof globalThis & {
      HotUpdater: { SDK_VERSION: string };
    }
  ).HotUpdater = { SDK_VERSION: "test-sdk-version" };

  return {
    fetchJSON: vi.fn(),
    fetchReleaseCatalogWithCache: vi.fn(),
  };
});

vi.mock("./fetchUpdateInfo", () => ({
  fetchJSON: mocks.fetchJSON,
}));

vi.mock("./releaseCatalogCache", () => ({
  fetchReleaseCatalogWithCache: mocks.fetchReleaseCatalogWithCache,
}));

const catalogParams = {
  appVersion: "1.2",
  authorityId: "project-a",
  channel: "production",
  fingerprintHash: null,
  platform: "ios" as const,
  requestHeaders: { authorization: "Bearer token" },
  requestTimeout: 1500,
  updateStrategy: "appVersion" as const,
};

describe("createDefaultResolver", () => {
  beforeEach(() => {
    mocks.fetchJSON.mockReset();
    mocks.fetchJSON.mockResolvedValue({});
    mocks.fetchReleaseCatalogWithCache.mockReset();
    mocks.fetchReleaseCatalogWithCache.mockResolvedValue({});
  });

  it("fetches a shared canonical Release catalog without legacy headers", async () => {
    const resolver = createDefaultResolver(
      "https://updates.example.com/hot-updater/",
      { authorityId: "project-a" },
    );

    expect(resolver.catalogCachePartition).toBe("x-api-key");
    await resolver.fetchReleaseCatalog?.(catalogParams);

    expect(mocks.fetchReleaseCatalogWithCache).toHaveBeenCalledWith({
      authorityId: "project-a",
      baseURL: "https://updates.example.com/hot-updater",
      requestHeaders: { authorization: "Bearer token" },
      requestTimeout: 1500,
      scopeKey: "v1:app-version:project-a:ios:cHJvZHVjdGlvbg",
      url: "https://updates.example.com/hot-updater/release-catalogs/app-version/project-a/ios/cHJvZHVjdGlvbg/1.2.0",
    });
  });

  it("resolves artifacts only from Bundle identities", async () => {
    const resolver = createDefaultResolver("https://updates.example.com", {
      authorityId: "project-a",
    });

    await resolver.resolveArtifact?.({
      currentBundleId: "bundle-1",
      targetBundleId: "bundle-2",
    });

    expect(mocks.fetchJSON).toHaveBeenCalledWith({
      requestHeaders: undefined,
      requestTimeout: undefined,
      url: "https://updates.example.com/artifacts/bundle-2/from/bundle-1",
    });
  });

  it("resolves a dynamic baseURL for every catalog request", async () => {
    const resolveBaseURL = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("https://one.example.com/")
      .mockResolvedValueOnce("https://two.example.com");
    const resolver = createDefaultResolver(resolveBaseURL, {
      authorityId: "project-a",
    });

    await resolver.fetchReleaseCatalog?.(catalogParams);
    await resolver.fetchReleaseCatalog?.(catalogParams);

    expect(resolveBaseURL).toHaveBeenCalledTimes(2);
    expect(
      mocks.fetchReleaseCatalogWithCache.mock.calls.map(
        ([input]) => input.baseURL,
      ),
    ).toEqual(["https://one.example.com", "https://two.example.com"]);
  });

  it("rejects an empty dynamic baseURL", async () => {
    const resolver = createDefaultResolver(() => "", {
      authorityId: "project-a",
    });

    await expect(resolver.fetchReleaseCatalog?.(catalogParams)).rejects.toThrow(
      "baseURL resolver must return a non-empty string",
    );
  });

  it("keeps SDK version sync from leaving source changes behind", async () => {
    const sdkVersionPath = join(__dirname, "sdkVersion.ts");
    const before = await readFile(sdkVersionPath, "utf-8");
    const result = spawnSync(
      process.execPath,
      [join(__dirname, "../scripts/sync-sdk-version.mjs")],
      {
        cwd: join(__dirname, ".."),
        encoding: "utf-8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    await expect(readFile(sdkVersionPath, "utf-8")).resolves.toBe(before);
  });
});
