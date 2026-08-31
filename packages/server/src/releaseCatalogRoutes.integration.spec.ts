import { encodeChannelKey } from "@hot-updater/core";
import { commitReleaseCatalogMutation } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import { registerApiKey } from "./apiKeys";
import { createHotUpdater } from "./index";

const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

const channelKey = encodeChannelKey("production");
const scopeKey = `v1:app-version:ios:${channelKey}`;

const createCatalogDatabase = async () => {
  const database = createInMemoryDatabasePlugin();
  const channel = { id: "channel-production", name: "production" };
  await database.models.channels.insert({
    onConflict: "returnExisting",
    row: channel,
  });
  const bundleId = "00000000-0000-7001-8000-000000000001";
  await database.commit({
    changes: [
      {
        model: "bundles",
        operation: "insert",
        row: {
          asset_base_storage_uri: null,
          archive_byte_size: 3_000_000_001,
          file_hash: "bundle-hash",
          git_commit_hash: null,
          id: bundleId,
          manifest_file_hash: null,
          manifest_storage_uri: null,
          metadata: {},
          platform: "ios",
          storage_uri: "storage://bundle.zip",
        },
      },
    ],
  });
  await commitReleaseCatalogMutation({
    database,
    mutation: {
      operation: "insert",
      row: {
        bundle_id: bundleId,
        channel_id: channel.id,
        created_at_ms: 1,
        enabled: true,
        fingerprint_hash: null,
        id: "00000000-0000-7000-8000-000000000001",
        kind: "BUNDLE",
        message: "Stable Release",
        operation: "DEPLOY",
        platform: "ios",
        revision: 1,
        rollout_cohort_count: 1000,
        scope_key: scopeKey,
        should_force_update: false,
        source_release_id: null,
        strategy: "APP_VERSION",
        target_app_version: ">=1.0.0 <2.0.0",
        target_cohorts: [],
        updated_at_ms: 1,
      },
    },
    scope: {
      channelId: channel.id,
      channelName: channel.name,
      fingerprintHash: null,
      platform: "ios",
      scopeKey,
      strategy: "APP_VERSION",
    },
    updatedAtMs: 1,
  });
  return database;
};

describe("Release catalog routes", () => {
  it("serves persisted Catalog identity without configuration and keeps it across server restarts", async () => {
    const database = await createCatalogDatabase();
    const storedCatalog =
      await database.models.releaseCatalogs.findByScopeKey(scopeKey);
    const hotUpdater = createHotUpdater({
      database,
      clientAccess: { type: "public" },
    });
    const catalogRead = vi.spyOn(
      database.models.releaseCatalogs,
      "findByScopeKey",
    );
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
    expect(catalogRead).toHaveBeenCalledOnce();

    const nonCanonicalVersion = await hotUpdater.handlers.client(
      new Request(url.replace("/1.5.0", "/v1.5")),
    );
    expect(nonCanonicalVersion.status).toBe(400);
    expect(nonCanonicalVersion.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(catalogRead).toHaveBeenCalledOnce();

    const invalidPlatform = await hotUpdater.handlers.client(
      new Request(url.replace("/ios/", "/windows/")),
    );
    expect(invalidPlatform.status).toBe(400);
    expect(catalogRead).toHaveBeenCalledOnce();

    const otherChannel = await hotUpdater.handlers.client(
      new Request(
        url.replace(`/${channelKey}/`, `/${encodeChannelKey("beta")}/`),
      ),
    );
    expect(otherChannel.status).toBe(404);
    expect(catalogRead).toHaveBeenCalledTimes(2);

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
    expect(catalogRead).toHaveBeenCalledTimes(2);
    const commit = vi.spyOn(database, "commit");
    const restarted = createHotUpdater({
      database,
      clientAccess: { type: "public" },
    });
    const relocated = await restarted.handlers.client(
      new Request(url.replace("updates.example.com", "new.example.com")),
    );
    expect(await relocated.json()).toEqual(body);
    expect(commit).not.toHaveBeenCalled();
  });

  it("singleflights concurrent cold requests into one exact catalog read", async () => {
    const database = await createCatalogDatabase();
    const catalogRead = vi.spyOn(
      database.models.releaseCatalogs,
      "findByScopeKey",
    );
    const hotUpdater = createHotUpdater({
      database,
      clientAccess: { type: "public" },
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
    expect(catalogRead).toHaveBeenCalledOnce();
  });

  it("varies authenticated catalog responses by the configured header", async () => {
    const database = await createCatalogDatabase();
    await registerApiKey({
      apiKeys: database.models.apiKeys,
      apiKey: API_KEY,
      name: "App",
    });
    const hotUpdater = createHotUpdater({
      clientAccess: {
        headerName: "X-Hot-Updater-Key",
        type: "api-key",
      },
      database,
    });
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
