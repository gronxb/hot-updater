import { encodeChannelKey } from "@hot-updater/core";
import { commitReleaseCatalogMutation } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import { createHotUpdater } from "./index";

const authorityId = "project-a";
const channelKey = encodeChannelKey("production");
const scopeKey = `v1:app-version:${authorityId}:ios:${channelKey}`;

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
      authorityId,
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
  it("serves the compiled app-version projection with cache identity and ETag revalidation", async () => {
    const database = await createCatalogDatabase();
    const hotUpdater = createHotUpdater({ authorityId, database });
    const catalogRead = vi.spyOn(
      database.models.releaseCatalogs,
      "findByScopeKey",
    );
    const url =
      `https://updates.example.com/release-catalogs/app-version/` +
      `${authorityId}/ios/${channelKey}/1.5.0`;

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
      authorityId,
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

    const wrongAuthority = await hotUpdater.handlers.client(
      new Request(url.replace(authorityId, "project-b")),
    );
    expect(wrongAuthority.status).toBe(404);
    expect(wrongAuthority.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("singleflights concurrent cold requests into one exact catalog read", async () => {
    const database = await createCatalogDatabase();
    const catalogRead = vi.spyOn(
      database.models.releaseCatalogs,
      "findByScopeKey",
    );
    const hotUpdater = createHotUpdater({ authorityId, database });
    const url =
      `https://updates.example.com/release-catalogs/app-version/` +
      `${authorityId}/ios/${channelKey}/1.5.0`;

    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        hotUpdater.handlers.client(new Request(url)),
      ),
    );

    expect(responses.every(({ status }) => status === 200)).toBe(true);
    expect(catalogRead).toHaveBeenCalledOnce();
  });
});
