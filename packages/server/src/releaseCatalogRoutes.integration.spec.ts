import type { EngineDatabase } from "@hot-updater/plugin-core";
import { encodeChannelKey } from "@hot-updater/protocol";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "./index";
import { apiKeys } from "./plugins/api-keys";
import { createRuntimeDatabase } from "./runtime.testFixtures";

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

const channelKey = encodeChannelKey("production");
const scopeKey = `v1:app-version:ios:${channelKey}`;

/** A database with one deployed release in production's app-version scope. */
const createCatalogDatabase = async () => {
  const database = createRuntimeDatabase();
  await createHotUpdater({
    database,
    storage: createReleaseCatalogTestStorage(),
    clientAccess: "public",
  }).core.deploy([
    {
      bundle: {
        assetBaseStorageUri: "storage://assets",
        gitCommitHash: null,
        id: "00000000-0000-7001-8000-000000000001",
        manifestFileHash: "manifest-hash",
        manifestStorageUri: "storage://bundle/manifest.json",
        metadata: {},
        platform: "ios",
      },
      release: {
        channel: "production",
        enabled: true,
        fingerprintHash: null,
        message: "Stable Release",
        shouldForceUpdate: false,
        targetAppVersion: ">=1.0.0 <2.0.0",
      },
    },
  ]);
  return database;
};

/** Counts point reads of catalog rows, the update check's one read. */
const countCatalogReads = (database: EngineDatabase) => {
  const get = vi.spyOn(database.adapter, "get");
  return () =>
    get.mock.calls.filter(([table]) => table.name === "release_catalogs")
      .length;
};

describe("Release catalog routes", () => {
  it("serves persisted Catalog identity without configuration and keeps it across server restarts", async () => {
    const database = await createCatalogDatabase();
    const storedCatalog = await createHotUpdater({
      database,
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    }).core.getReleaseCatalogRow(scopeKey);
    const catalogReads = countCatalogReads(database);
    const hotUpdater = createHotUpdater({
      database,
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    });
    const url =
      `https://updates.example.com/release-catalogs/app-version/` +
      `ios/${channelKey}/1.5.0`;

    const response = await hotUpdater.handlers.client(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=5",
    );
    // A CDN that reads CDN-Cache-Control serves an expired catalog while it
    // revalidates; s-maxage would forbid that.
    expect(response.headers.get("cdn-cache-control")).toBe(
      "public, max-age=5, stale-while-revalidate=5, stale-if-error=0",
    );
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.hot-updater.release-catalog+json; version=1",
    );
    const body = await response.json();
    expect(body).toMatchObject({
      catalogId: storedCatalog!.catalog_id,
      fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
      generation: 1,
      releases: [
        {
          bundleId: "00000000-0000-7001-8000-000000000001",
          kind: "BUNDLE",
          message: "Stable Release",
          shouldForceUpdate: false,
        },
      ],
      rollbackReleases: [
        {
          bundleId: "00000000-0000-7001-8000-000000000001",
          kind: "BUNDLE",
        },
      ],
      scopeKey,
    });

    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"sha256:[0-9a-f]{64}"$/);
    const revalidated = await hotUpdater.handlers.client(
      new Request(url, { headers: { "if-none-match": etag! } }),
    );
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
    expect(revalidated.headers.get("cdn-cache-control")).toBe(
      response.headers.get("cdn-cache-control"),
    );
    expect(catalogReads()).toBe(1);

    const nonCanonicalVersion = await hotUpdater.handlers.client(
      new Request(url.replace("/1.5.0", "/v1.5")),
    );
    expect(nonCanonicalVersion.status).toBe(400);
    expect(nonCanonicalVersion.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(catalogReads()).toBe(1);

    const invalidPlatform = await hotUpdater.handlers.client(
      new Request(url.replace("/ios/", "/windows/")),
    );
    expect(invalidPlatform.status).toBe(400);
    expect(catalogReads()).toBe(1);

    const otherChannel = await hotUpdater.handlers.client(
      new Request(
        url.replace(`/${channelKey}/`, `/${encodeChannelKey("beta")}/`),
      ),
    );
    expect(otherChannel.status).toBe(404);
    expect(otherChannel.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=5",
    );
    expect(otherChannel.headers.get("cdn-cache-control")).toBe(
      "public, max-age=5, stale-while-revalidate=5, stale-if-error=0",
    );
    expect(otherChannel.headers.get("x-hot-updater-catalog")).toBe("none");
    expect(catalogReads()).toBe(2);

    const legacyAuthorityPath = await hotUpdater.handlers.client(
      new Request(
        `https://updates.example.com/release-catalogs/app-version/` +
          `old-authority/ios/${channelKey}/1.5.0`,
      ),
    );
    expect(legacyAuthorityPath.status).toBe(404);
    expect(legacyAuthorityPath.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(legacyAuthorityPath.headers.has("x-hot-updater-catalog")).toBe(
      false,
    );
    expect(catalogReads()).toBe(2);
    const write = vi.spyOn(database.adapter, "write");
    const restarted = createHotUpdater({
      database,
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    });
    const relocated = await restarted.handlers.client(
      new Request(url.replace("updates.example.com", "new.example.com")),
    );
    expect(await relocated.json()).toEqual(body);
    expect(write).not.toHaveBeenCalled();
  });

  it("singleflights concurrent cold requests into one exact catalog read", async () => {
    const database = await createCatalogDatabase();
    const catalogReads = countCatalogReads(database);
    const hotUpdater = createHotUpdater({
      database,
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    });
    const url =
      `https://updates.example.com/release-catalogs/app-version/` +
      `ios/${channelKey}/1.5.0`;

    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        hotUpdater.handlers.client(new Request(url)),
      ),
    );

    expect(responses.every(({ status }) => status === 200)).toBe(true);
    expect(catalogReads()).toBe(1);
  });

  it("remembers a scope without a catalog for five seconds, so its update checks read it once", async () => {
    const database = await createCatalogDatabase();
    const catalogReads = countCatalogReads(database);
    let now = Date.UTC(2026, 0, 1);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const hotUpdater = createHotUpdater({
      database,
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    });
    const betaUrl =
      `https://updates.example.com/release-catalogs/app-version/` +
      `ios/${encodeChannelKey("beta")}/1.5.0`;
    const check = () => hotUpdater.handlers.client(new Request(betaUrl));

    const first = await check();
    expect(first.status).toBe(404);
    expect(first.headers.get("x-hot-updater-catalog")).toBe("none");
    now += 4_999;
    const remembered = await check();
    expect(remembered.status).toBe(404);
    expect(remembered.headers.get("x-hot-updater-catalog")).toBe("none");
    const concurrent = await Promise.all(Array.from({ length: 50 }, check));
    expect(concurrent.every(({ status }) => status === 404)).toBe(true);
    expect(catalogReads()).toBe(1);

    // The scope's first release shows once the miss's five seconds pass.
    await hotUpdater.core.deploy([
      {
        bundle: {
          assetBaseStorageUri: "storage://assets",
          gitCommitHash: null,
          id: "00000000-0000-7001-8000-000000000002",
          manifestFileHash: "manifest-hash-beta",
          manifestStorageUri: "storage://bundle/beta/manifest.json",
          metadata: {},
          platform: "ios",
        },
        release: {
          channel: "beta",
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "*",
        },
      },
    ]);
    const reads = catalogReads();
    now += 1;
    const deployed = await check();
    expect(deployed.status).toBe(200);
    expect(catalogReads()).toBe(reads + 1);
  });

  it("singleflights concurrent cold requests of a scope without a catalog into one read", async () => {
    const database = await createCatalogDatabase();
    const catalogReads = countCatalogReads(database);
    const hotUpdater = createHotUpdater({
      database,
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    });
    const url =
      `https://updates.example.com/release-catalogs/app-version/` +
      `ios/${encodeChannelKey("beta")}/1.5.0`;

    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        hotUpdater.handlers.client(new Request(url)),
      ),
    );

    expect(responses.every(({ status }) => status === 404)).toBe(true);
    expect(catalogReads()).toBe(1);
  });

  it("never lets scopes without a catalog evict a scope's catalog from the memo", async () => {
    const database = await createCatalogDatabase();
    const get = vi.spyOn(database.adapter, "get");
    const hotUpdater = createHotUpdater({
      database,
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    });
    const deployedUrl =
      `https://updates.example.com/release-catalogs/app-version/` +
      `ios/${channelKey}/1.5.0`;
    const deployedReads = () =>
      get.mock.calls.filter(
        ([table, keys]) =>
          table.name === "release_catalogs" &&
          keys.some((key) => key[0] === scopeKey),
      ).length;

    expect(
      (await hotUpdater.handlers.client(new Request(deployedUrl))).status,
    ).toBe(200);
    // More scopes without a catalog than the memo holds.
    for (let n = 0; n < 300; n += 1) {
      const missing = await hotUpdater.handlers.client(
        new Request(
          `https://updates.example.com/release-catalogs/fingerprint/` +
            `android/${channelKey}/fingerprint-${n}`,
        ),
      );
      expect(missing.status).toBe(404);
    }
    expect(
      (await hotUpdater.handlers.client(new Request(deployedUrl))).status,
    ).toBe(200);
    expect(deployedReads()).toBe(1);
  });

  it("reads a scope's catalog once for every app version it serves, and projects each version from it", async () => {
    const database = createRuntimeDatabase();
    const storage = createReleaseCatalogTestStorage();
    const deployer = createHotUpdater({
      database,
      storage,
      clientAccess: "public",
    });
    // Releases each app version sees differently, so a memo that served one
    // version's projection to another would answer the wrong releases.
    for (const [n, targetAppVersion] of [
      [1, "*"],
      [2, "1.x.x"],
      [3, "2.x.x"],
    ] as const) {
      await deployer.core.deploy([
        {
          bundle: {
            assetBaseStorageUri: "storage://assets",
            gitCommitHash: null,
            id: `00000000-0000-7001-8000-00000000000${n}`,
            manifestFileHash: `manifest-hash-${n}`,
            manifestStorageUri: `storage://bundle/${n}/manifest.json`,
            metadata: {},
            platform: "ios",
          },
          release: {
            channel: "production",
            enabled: true,
            fingerprintHash: null,
            message: null,
            shouldForceUpdate: false,
            targetAppVersion,
          },
        },
      ]);
    }
    const versions = Array.from(
      { length: 20 },
      (_, n) => `${(n % 3) + 1}.0.${Math.floor(n / 3)}`,
    );
    const urlOf = (appVersion: string) =>
      `https://updates.example.com/release-catalogs/app-version/` +
      `ios/${channelKey}/${appVersion}`;
    const expected = new Map(
      await Promise.all(
        versions.map(
          async (appVersion) =>
            [
              appVersion,
              await deployer.core.getReleaseCatalog({
                appVersion,
                channelKey,
                platform: "ios",
                strategy: "APP_VERSION",
              }),
            ] as const,
        ),
      ),
    );
    expect(
      new Set([...expected.values()].map((catalog) => catalog!.releases.length))
        .size,
    ).toBe(2);

    const reads = [];
    for (const order of ["one after another", "all at once"] as const) {
      const catalogReads = countCatalogReads(database);
      const hotUpdater = createHotUpdater({
        database,
        storage,
        clientAccess: "public",
      });
      const check = (appVersion: string) =>
        hotUpdater.handlers.client(new Request(urlOf(appVersion)));
      const responses =
        order === "all at once"
          ? await Promise.all(versions.map(check))
          : await versions.reduce<Promise<Response[]>>(
              async (done, appVersion) => [
                ...(await done),
                await check(appVersion),
              ],
              Promise.resolve([]),
            );
      for (const [index, response] of responses.entries()) {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected.get(versions[index]!));
      }
      reads.push({ order, catalogReads: catalogReads() });
      vi.restoreAllMocks();
    }
    expect(reads).toEqual([
      { order: "one after another", catalogReads: 1 },
      { order: "all at once", catalogReads: 1 },
    ]);
  });

  it("varies authenticated catalog responses by the configured header", async () => {
    const hotUpdater = createHotUpdater({
      database: await createCatalogDatabase(),
      storage: createReleaseCatalogTestStorage(),
      plugins: [apiKeys({ headerName: "X-Hot-Updater-Key" })],
    });
    await hotUpdater.api.apiKeys.register({ apiKey: API_KEY, name: "App" });
    const url =
      `https://updates.example.com/release-catalogs/app-version/` +
      `ios/${channelKey}/1.5.0`;

    const unauthorized = await hotUpdater.handlers.client(
      new Request(url, { headers: { "x-api-key": API_KEY } }),
    );
    expect(unauthorized.status).toBe(401);

    const response = await hotUpdater.handlers.client(
      new Request(url, { headers: { "x-hot-updater-key": API_KEY } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBe(
      "Accept-Encoding, x-hot-updater-key",
    );
  });
});
