import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactInfo } from "@hot-updater/core";
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

vi.mock("./fetchJSON", () => ({
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

const artifactInfo: ArtifactInfo = {
  changedAssets: {
    "index.bundle": {
      file: {
        url: "https://cdn.example.com/index.bundle?signature=preserved",
      },
      fileHash: "asset-hash",
      patch: {
        algorithm: "bsdiff",
        baseBundleId: "bundle-1",
        baseFileHash: "base-hash",
        patchFileHash: "patch-hash",
        patchUrl: "/storage/patch-token/patch-signature",
      },
    },
  },
  fileHash: "archive-hash",
  fileUrl: "/storage/archive-token/archive-signature%2Fencoded",
  manifestFileHash: "manifest-hash",
  manifestUrl: "/storage/manifest-token/manifest-signature",
};

describe("createDefaultResolver", () => {
  beforeEach(() => {
    mocks.fetchJSON.mockReset();
    mocks.fetchJSON.mockResolvedValue(artifactInfo);
    mocks.fetchReleaseCatalogWithCache.mockReset();
    mocks.fetchReleaseCatalogWithCache.mockResolvedValue({});
  });

  it("fetches a shared canonical Release catalog without legacy headers", async () => {
    const resolver = createDefaultResolver(
      "https://updates.example.com/hot-updater/",
      { authorityId: "project-a" },
    );

    expect(resolver.catalogCachePartition).toBe("x-api-key");
    await resolver.fetchReleaseCatalog(catalogParams);

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

    const info = await resolver.resolveArtifact({
      currentBundleId: "bundle-1",
      targetBundleId: "bundle-2",
    });

    expect(mocks.fetchJSON).toHaveBeenCalledWith({
      requestHeaders: undefined,
      requestTimeout: undefined,
      url: "https://updates.example.com/artifacts/bundle-2/from/bundle-1",
    });
    expect(info?.fileUrl).toBe(
      "https://updates.example.com/storage/archive-token/archive-signature%2Fencoded",
    );
  });

  it("resolves server storage paths against the same nested client base URL", async () => {
    const resolveBaseURL = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("https://updates.example.com/hot-updater/");
    const resolver = createDefaultResolver(resolveBaseURL);

    const info = await resolver.resolveArtifact({
      currentBundleId: "bundle-1",
      targetBundleId: "bundle-2",
    });

    expect(resolveBaseURL).toHaveBeenCalledOnce();
    expect(info).toMatchObject({
      fileUrl:
        "https://updates.example.com/hot-updater/storage/archive-token/archive-signature%2Fencoded",
      manifestUrl:
        "https://updates.example.com/hot-updater/storage/manifest-token/manifest-signature",
      changedAssets: {
        "index.bundle": {
          file: {
            url: "https://cdn.example.com/index.bundle?signature=preserved",
          },
          patch: {
            patchUrl:
              "https://updates.example.com/hot-updater/storage/patch-token/patch-signature",
          },
        },
      },
    });
  });

  it("preserves nullable artifact URL fields", async () => {
    mocks.fetchJSON.mockResolvedValue({
      ...artifactInfo,
      changedAssets: null,
      fileUrl: null,
      manifestUrl: null,
    });
    const resolver = createDefaultResolver("https://updates.example.com");

    await expect(
      resolver.resolveArtifact({
        currentBundleId: "bundle-1",
        targetBundleId: "bundle-2",
      }),
    ).resolves.toMatchObject({
      changedAssets: null,
      fileUrl: null,
      manifestUrl: null,
    });
  });

  it("rejects unexpected relative artifact paths", async () => {
    mocks.fetchJSON.mockResolvedValue({
      ...artifactInfo,
      fileUrl: "/other/archive.zip",
    });
    const resolver = createDefaultResolver("https://updates.example.com");

    await expect(
      resolver.resolveArtifact({
        currentBundleId: "bundle-1",
        targetBundleId: "bundle-2",
      }),
    ).rejects.toThrow(
      "Artifact URLs must be absolute HTTP(S) URLs or client-relative storage paths.",
    );
  });

  it("resolves a dynamic baseURL for every catalog request", async () => {
    const resolveBaseURL = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("https://one.example.com/")
      .mockResolvedValueOnce("https://two.example.com");
    const resolver = createDefaultResolver(resolveBaseURL, {
      authorityId: "project-a",
    });

    await resolver.fetchReleaseCatalog(catalogParams);
    await resolver.fetchReleaseCatalog(catalogParams);

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

    await expect(resolver.fetchReleaseCatalog(catalogParams)).rejects.toThrow(
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
