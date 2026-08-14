import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  MAX_COMPILED_CATALOG_BYTES,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createReleaseCatalogCachePartition,
  fetchReleaseCatalogWithCache,
  MAX_RELEASE_CATALOG_CACHE_ENTRY_BYTES,
  MAX_RELEASE_CATALOG_WIRE_BYTES,
} from "./releaseCatalogCache";

const cache = vi.hoisted(() => new Map<string, string>());
const nativeMocks = vi.hoisted(() => ({
  read: vi.fn(async (partition: string) => cache.get(partition) ?? null),
  remove: vi.fn(async (partition: string) => {
    cache.delete(partition);
  }),
  write: vi.fn(async (partition: string, payload: string) => {
    cache.set(partition, payload);
    return true;
  }),
}));

vi.mock("./catalogCacheNative", () => ({
  readNativeReleaseCatalogCache: nativeMocks.read,
  removeNativeReleaseCatalogCache: nativeMocks.remove,
  writeNativeReleaseCatalogCache: nativeMocks.write,
}));

const AUTHORITY_ID = "project-a";
const CHANNEL_KEY = encodeChannelKey("production");
const SCOPE_KEY = createReleaseCatalogScopeKey({
  authorityId: AUTHORITY_ID,
  channelKey: CHANNEL_KEY,
  platform: "ios",
  strategy: "APP_VERSION",
});
const URL = `https://updates.example.com/v2/release-catalogs/app-version/${AUTHORITY_ID}/ios/${CHANNEL_KEY}/1.0.0`;

const catalog: ReleaseCatalog = {
  authorityId: AUTHORITY_ID,
  catalogHash: `sha256:${"a".repeat(64)}`,
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  generation: 1,
  releases: [
    {
      bundleId: "00000000-0000-7000-8000-000000000002",
      kind: "BUNDLE",
      message: null,
      releaseId: "00000000-0000-7000-8000-000000000001",
      rolloutCohortCount: 1000,
      shouldForceUpdate: false,
      targetCohorts: [],
    },
  ],
  schemaVersion: 1,
  scopeKey: SCOPE_KEY,
};

const input = (
  overrides: Partial<Parameters<typeof fetchReleaseCatalogWithCache>[0]> = {},
) => ({
  authorityId: AUTHORITY_ID,
  baseURL: "https://updates.example.com",
  requestHeaders: { "X-API-Key": "client-key-a" },
  scopeKey: SCOPE_KEY,
  url: URL,
  ...overrides,
});

const response = (status: number, body?: string, etag?: string) =>
  new Response(body, {
    headers: etag === undefined ? undefined : { ETag: etag },
    status,
    statusText: status === 200 ? "OK" : "Request failed",
  });

const requestHeadersAt = (
  fetchMock: ReturnType<typeof vi.fn>,
  index: number,
) => {
  const request = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return new Headers(request?.headers);
};

describe("Release Catalog persistent cache", () => {
  beforeEach(() => {
    cache.clear();
    vi.clearAllMocks();
  });

  it("persists a validated 200 and reuses it across resolver instances on 304", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, JSON.stringify(catalog), '"v1"'))
      .mockResolvedValueOnce(response(304));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReleaseCatalogWithCache(input())).resolves.toEqual(
      catalog,
    );
    expect(nativeMocks.write).toHaveBeenCalledOnce();

    const parseSpy = vi.spyOn(JSON, "parse");
    await expect(fetchReleaseCatalogWithCache(input())).resolves.toEqual(
      catalog,
    );
    expect(requestHeadersAt(fetchMock, 1).get("if-none-match")).toBe('"v1"');
    expect(parseSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("repairs an invalid cache after an unsatisfiable 304 with one unconditional request", async () => {
    const partition = createReleaseCatalogCachePartition(input());
    cache.set(partition, "invalid-envelope");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(304))
      .mockResolvedValueOnce(response(200, JSON.stringify(catalog), '"v2"'));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReleaseCatalogWithCache(input())).resolves.toEqual(
      catalog,
    );

    expect(nativeMocks.remove).toHaveBeenCalledWith(partition);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestHeadersAt(fetchMock, 0).has("if-none-match")).toBe(false);
    expect(requestHeadersAt(fetchMock, 1).has("if-none-match")).toBe(false);
    expect(cache.get(partition)).toContain('"v2"');
  });

  it("isolates base URL, scope, and case-insensitive API-key partitions", async () => {
    const betaScope = createReleaseCatalogScopeKey({
      authorityId: AUTHORITY_ID,
      channelKey: encodeChannelKey("beta"),
      platform: "ios",
      strategy: "APP_VERSION",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, JSON.stringify(catalog), '"v1"'))
      .mockResolvedValueOnce(response(304))
      .mockResolvedValueOnce(response(200, JSON.stringify(catalog), '"key-b"'))
      .mockResolvedValueOnce(
        response(
          200,
          JSON.stringify({ ...catalog, scopeKey: betaScope }),
          '"beta"',
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchReleaseCatalogWithCache(input());
    await fetchReleaseCatalogWithCache(
      input({ requestHeaders: { "x-api-key": "client-key-a" } }),
    );
    await fetchReleaseCatalogWithCache(
      input({ requestHeaders: { "x-api-key": "client-key-b" } }),
    );
    await fetchReleaseCatalogWithCache(
      input({
        baseURL: "https://other.example.com",
        scopeKey: betaScope,
        url: "https://other.example.com/v2/release-catalogs/app-version/project-a/ios/YmV0YQ/1.0.0",
      }),
    );

    expect(requestHeadersAt(fetchMock, 1).get("if-none-match")).toBe('"v1"');
    expect(requestHeadersAt(fetchMock, 2).has("if-none-match")).toBe(false);
    expect(requestHeadersAt(fetchMock, 3).has("if-none-match")).toBe(false);
    expect(cache.size).toBe(3);
  });

  it.each([401, 403, 500])(
    "does not use or repair cached data after HTTP %s",
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response(200, JSON.stringify(catalog), '"v1"'))
        .mockResolvedValueOnce(response(status));
      vi.stubGlobal("fetch", fetchMock);
      await fetchReleaseCatalogWithCache(input());

      await expect(fetchReleaseCatalogWithCache(input())).rejects.toThrow(
        "Request failed",
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("does not use cached data as a fallback on network failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, JSON.stringify(catalog), '"v1"'))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    await fetchReleaseCatalogWithCache(input());

    await expect(fetchReleaseCatalogWithCache(input())).rejects.toThrow(
      "offline",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects and never persists a catalog with the wrong canonical scope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          200,
          JSON.stringify({ ...catalog, scopeKey: "wrong-scope" }),
          '"wrong"',
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReleaseCatalogWithCache(input())).rejects.toThrow(
      "invalid Release catalog",
    );
    expect(nativeMocks.write).not.toHaveBeenCalled();
  });

  it("accepts a legal compiled-boundary catalog plus its wire envelope", async () => {
    const template = {
      ...catalog,
      releases: [{ ...catalog.releases[0]!, message: "" }],
    };
    const templateBody = JSON.stringify(template);
    const padding = "x".repeat(
      MAX_COMPILED_CATALOG_BYTES + 1 - templateBody.length,
    );
    const body = JSON.stringify({
      ...template,
      releases: [{ ...template.releases[0]!, message: padding }],
    });
    expect(body.length).toBe(MAX_COMPILED_CATALOG_BYTES + 1);
    expect(body.length).toBeLessThanOrEqual(MAX_RELEASE_CATALOG_WIRE_BYTES);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, body, '"boundary"'));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchReleaseCatalogWithCache(input())).resolves.toEqual(
      JSON.parse(body),
    );

    const persisted = nativeMocks.write.mock.calls[0]?.[1];
    expect(persisted).toBeDefined();
    expect(new TextEncoder().encode(persisted).byteLength).toBeLessThanOrEqual(
      MAX_RELEASE_CATALOG_CACHE_ENTRY_BYTES,
    );
  });
});
