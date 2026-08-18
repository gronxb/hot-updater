import { describe, expect, it } from "vitest";

import { createMemoryDatabasePlugin } from "./databasePluginMemory.testFixtures";
import {
  commitReleaseCatalogMutation,
  rebuildReleaseCatalog,
} from "./releaseCatalogMutation";
import type { ReleaseRow } from "./types";

const scopeKey = "v1:app-version:project-a:ios:cHJvZHVjdGlvbg";
const scope = {
  authorityId: "project-a",
  channelId: "channel-production",
  channelName: "production",
  fingerprintHash: null,
  platform: "ios",
  scopeKey,
  strategy: "APP_VERSION",
} as const;

const release: ReleaseRow = {
  bundle_id: "00000000-0000-7001-8000-000000000001",
  channel_id: scope.channelId,
  created_at_ms: 1,
  enabled: true,
  fingerprint_hash: null,
  id: "00000000-0000-7000-8000-000000000001",
  kind: "BUNDLE",
  message: null,
  operation: "DEPLOY",
  platform: "ios",
  revision: 1,
  rollout_cohort_count: 1000,
  scope_key: scopeKey,
  should_force_update: false,
  source_release_id: null,
  strategy: "APP_VERSION",
  target_app_version: ">=1.0.0",
  target_cohorts: [],
  updated_at_ms: 1,
};

describe("commitReleaseCatalogMutation", () => {
  it("atomically advances Release revision and catalog generation, then tombstones an empty scope", async () => {
    const database = createMemoryDatabasePlugin();
    await database.models.channels.insert({
      onConflict: "returnExisting",
      row: { id: scope.channelId, name: scope.channelName },
    });
    await database.commit({
      changes: [
        {
          model: "bundles",
          operation: "insert",
          row: {
            asset_base_storage_uri: null,
            file_hash: "bundle-hash",
            git_commit_hash: null,
            id: release.bundle_id!,
            manifest_file_hash: null,
            manifest_storage_uri: null,
            metadata: {},
            platform: "ios",
            storage_uri: "storage://bundle.zip",
          },
        },
      ],
    });

    const inserted = await commitReleaseCatalogMutation({
      database,
      mutation: { operation: "insert", row: release },
      scope,
      updatedAtMs: 1,
    });
    expect(inserted.catalog).toMatchObject({
      generation: 1,
      is_tombstone: false,
    });
    expect(JSON.parse(inserted.catalog.payload)).toMatchObject({
      fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
      strategy: "APP_VERSION",
    });

    const updated = await commitReleaseCatalogMutation({
      database,
      mutation: {
        id: release.id,
        operation: "update",
        update: { enabled: false, updated_at_ms: 2 },
      },
      scope,
      updatedAtMs: 2,
    });
    expect(updated.release).toMatchObject({ enabled: false, revision: 2 });
    expect(updated.catalog).toMatchObject({
      generation: 2,
      is_tombstone: true,
    });

    const removed = await commitReleaseCatalogMutation({
      database,
      mutation: { id: release.id, operation: "delete" },
      scope,
      updatedAtMs: 3,
    });
    expect(removed.release).toBeNull();
    expect(removed.catalog).toMatchObject({
      generation: 3,
      is_tombstone: true,
    });
    expect(await database.models.releases.findById(release.id)).toBeNull();
  });

  it("creates a missing catalog at generation one from canonical Releases", async () => {
    const database = createMemoryDatabasePlugin();
    await database.models.channels.insert({
      onConflict: "returnExisting",
      row: { id: scope.channelId, name: scope.channelName },
    });
    await database.commit({
      changes: [
        {
          model: "bundles",
          operation: "insert",
          row: {
            asset_base_storage_uri: null,
            file_hash: "bundle-hash",
            git_commit_hash: null,
            id: release.bundle_id!,
            manifest_file_hash: null,
            manifest_storage_uri: null,
            metadata: {},
            platform: "ios",
            storage_uri: "storage://bundle.zip",
          },
        },
        { model: "releases", operation: "insert", row: release },
      ],
    });

    await expect(
      database.models.releaseCatalogs.findByScopeKey(scope.scopeKey),
    ).resolves.toBeNull();

    const result = await rebuildReleaseCatalog({
      database,
      scope,
      updatedAtMs: 2,
    });

    expect(result).toMatchObject({
      attempts: 1,
      catalog: { generation: 1, is_tombstone: false },
      changed: true,
    });
    await expect(
      database.models.releaseCatalogs.findByScopeKey(scope.scopeKey),
    ).resolves.toEqual(result.catalog);
  });

  it("leaves the previous projection untouched when compilation is oversized", async () => {
    const database = createMemoryDatabasePlugin();
    const fingerprintScope = {
      ...scope,
      fingerprintHash: "fingerprint-a",
      scopeKey: "v1:fingerprint:project-a:ios:cHJvZHVjdGlvbg:fingerprint-a",
      strategy: "FINGERPRINT",
    } as const;
    await database.models.channels.insert({
      onConflict: "returnExisting",
      row: { id: scope.channelId, name: scope.channelName },
    });
    const seededBundles = Array.from({ length: 20_000 }, (_, index) => ({
      asset_base_storage_uri: null,
      file_hash: `hash-${index}`,
      git_commit_hash: null,
      id: `00000000-0000-7001-8000-${String(index + 1).padStart(12, "0")}`,
      manifest_file_hash: null,
      manifest_storage_uri: null,
      metadata: {},
      platform: "ios" as const,
      storage_uri: `storage://bundles/${index}.zip`,
    }));
    const seededReleases = seededBundles.map((bundle, index) => ({
      ...release,
      bundle_id: bundle.id,
      fingerprint_hash: fingerprintScope.fingerprintHash,
      id: `00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
      kind: "BUNDLE" as const,
      rollout_cohort_count: 1,
      scope_key: fingerprintScope.scopeKey,
      strategy: "FINGERPRINT" as const,
      target_app_version: null,
    }));
    const previousCatalog = {
      authority_id: fingerprintScope.authorityId,
      byte_size: 2,
      catalog_hash: "sha256:previous",
      channel_id: fingerprintScope.channelId,
      channel_key: "cHJvZHVjdGlvbg",
      fingerprint_hash: fingerprintScope.fingerprintHash,
      generation: 1,
      is_tombstone: false,
      payload: "{}",
      platform: fingerprintScope.platform,
      scope_key: fingerprintScope.scopeKey,
      strategy: fingerprintScope.strategy,
      updated_at_ms: 1,
    } as const;
    await database.commit({
      changes: [
        ...seededBundles.map((row) => ({
          model: "bundles" as const,
          operation: "insert" as const,
          row,
        })),
        ...seededReleases.map((row) => ({
          model: "releases" as const,
          operation: "insert" as const,
          row,
        })),
        {
          model: "releaseCatalogs",
          operation: "put",
          row: previousCatalog,
        },
      ],
    });
    const rejectedRelease = {
      ...seededReleases.at(-1)!,
      bundle_id: seededBundles.at(-1)!.id,
      id: "00000000-0000-7000-8000-999999999999",
    };

    await expect(
      commitReleaseCatalogMutation({
        database,
        mutation: { operation: "insert", row: rejectedRelease },
        scope: fingerprintScope,
        updatedAtMs: 2,
      }),
    ).rejects.toMatchObject({ code: "CATALOG_OVERSIZE" });

    await expect(
      database.models.releases.findById(rejectedRelease.id),
    ).resolves.toBeNull();
    await expect(
      database.models.releaseCatalogs.findByScopeKey(fingerprintScope.scopeKey),
    ).resolves.toEqual(previousCatalog);
  }, 20_000);
});
