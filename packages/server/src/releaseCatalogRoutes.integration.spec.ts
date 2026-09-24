import { encodeChannelKey } from "@hot-updater/core";
import type { EngineDatabase } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createDatabaseCoreApi } from "./core/api";
import { createHotUpdater } from "./index";
import { apiKeys } from "./plugins/api-keys";
import { createRuntimeDatabase } from "./runtime.testFixtures";

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

const channelKey = encodeChannelKey("production");
const scopeKey = `v1:app-version:ios:${channelKey}`;

/** A database with one deployed release in production's app-version scope. */
const createCatalogDatabase = async () => {
  const database = createRuntimeDatabase();
  await createDatabaseCoreApi(database).deploy([
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
    const storedCatalog =
      await createDatabaseCoreApi(database).getReleaseCatalogRow(scopeKey);
    const catalogReads = countCatalogReads(database);
    const hotUpdater = createHotUpdater({
      database,
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
    expect(catalogReads()).toBe(2);
    const write = vi.spyOn(database.adapter, "write");
    const restarted = createHotUpdater({
      database,
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

  it("varies authenticated catalog responses by the configured header", async () => {
    const hotUpdater = createHotUpdater({
      database: await createCatalogDatabase(),
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
