import type { ArtifactInfo, ReleaseCatalog } from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpClient } from "./httpClient";

const mocks = vi.hoisted(() => {
  Reflect.set(globalThis, "HotUpdater", {
    SDK_VERSION: "test-sdk-version",
  });
  return {
    fetchCatalog: vi.fn(),
    fetchJSON: vi.fn(),
  };
});

vi.mock("./releaseCatalogCache", () => ({
  fetchReleaseCatalogWithCache: mocks.fetchCatalog,
}));

vi.mock("./fetchJSON", () => ({
  fetchJSON: mocks.fetchJSON,
}));

const artifact: ArtifactInfo = {
  fileHash: "bundle-hash",
  fileUrl: "/storage/bundle.zip",
};

const catalog: ReleaseCatalog = {
  catalogId: "server-owned-project",
  catalogHash: `sha256:${"a".repeat(64)}`,
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  generation: 1,
  releases: [],
  schemaVersion: 1,
  scopeKey: "v1:app-version:server-owned-project:ios:cHJvZHVjdGlvbg",
};

describe("private HotUpdater HTTP client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchCatalog.mockResolvedValue(catalog);
    mocks.fetchJSON.mockResolvedValue(artifact);
  });

  it("fetches a catalog without putting its internal identity in the route", async () => {
    const session = await createHttpClient(
      "https://updates.example.com/hot-updater/",
    ).createSession();

    await expect(
      session.fetchReleaseCatalog({
        appVersion: "1.2.0",
        channel: "production",
        fingerprintHash: null,
        platform: "ios",
        updateStrategy: "appVersion",
      }),
    ).resolves.toBe(catalog);

    expect(mocks.fetchCatalog).toHaveBeenCalledWith({
      baseURL: "https://updates.example.com/hot-updater",
      expectedScope: {
        channelKey: "cHJvZHVjdGlvbg",
        platform: "ios",
        strategy: "APP_VERSION",
      },
      requestHeaders: undefined,
      requestTimeout: undefined,
      url: "https://updates.example.com/hot-updater/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.2.0",
    });
  });

  it("resolves a functional baseURL once per session and captures it for a deferred artifact", async () => {
    const resolveBaseURL = vi
      .fn()
      .mockResolvedValueOnce("https://first.example.com/hot-updater")
      .mockResolvedValueOnce("https://second.example.com/hot-updater");
    const client = createHttpClient(resolveBaseURL);
    const firstSession = await client.createSession();

    await firstSession.fetchReleaseCatalog({
      appVersion: "1.2.0",
      channel: "production",
      fingerprintHash: null,
      platform: "ios",
      updateStrategy: "appVersion",
    });
    await expect(
      firstSession.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).resolves.toEqual({
      ...artifact,
      fileUrl: "https://first.example.com/hot-updater/storage/bundle.zip",
    });

    expect(resolveBaseURL).toHaveBeenCalledOnce();
    expect(mocks.fetchJSON).toHaveBeenCalledWith({
      requestHeaders: undefined,
      requestTimeout: undefined,
      url: "https://first.example.com/hot-updater/artifacts/target/from/current",
    });

    await client.createSession();
    expect(resolveBaseURL).toHaveBeenCalledTimes(2);
  });

  it("rejects non-storage relative artifact URLs", async () => {
    mocks.fetchJSON.mockResolvedValue({
      ...artifact,
      fileUrl: "/private/bundle.zip",
    });
    const session = await createHttpClient(
      "https://updates.example.com",
    ).createSession();

    await expect(
      session.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).rejects.toThrow("client-relative storage paths");
  });

  it("requires a functional baseURL to resolve to a non-empty string", async () => {
    await expect(createHttpClient(() => "").createSession()).rejects.toThrow(
      "baseURL function must return a non-empty string",
    );
  });
});
