import { describe, expect, it } from "vitest";

import { createMemoryDatabasePlugin } from "./databasePluginMemory.testFixtures";
import {
  commitReleaseCatalogMutation,
  preflightReleaseCatalogRebuild,
  rebuildReleaseCatalog,
} from "./releaseCatalogMutation";
import type { ReleaseRow } from "./types";

const scopeKey = "v1:app-version:ios:cHJvZHVjdGlvbg";
const scope = {
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
  it("adopts the first writer's identity when it commits between scope reads", async () => {
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
            archive_byte_size: 1024,
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
    const firstRelease: ReleaseRow = {
      ...release,
      target_app_version: "1.0.0",
    };
    let interleaved = false;
    let winningCatalogId: string | undefined;
    const interleavedDatabase = {
      ...database,
      models: {
        ...database.models,
        releases: {
          ...database.models.releases,
          async findManyByScope(
            input: Parameters<
              typeof database.models.releases.findManyByScope
            >[0],
          ) {
            if (!interleaved) {
              interleaved = true;
              const winner = await commitReleaseCatalogMutation({
                database,
                mutation: { operation: "insert", row: firstRelease },
                scope,
              });
              winningCatalogId = winner.catalog.catalog_id;
            }
            return database.models.releases.findManyByScope(input);
          },
        },
      },
    };

    const result = await commitReleaseCatalogMutation({
      database: interleavedDatabase,
      mutation: {
        operation: "insert",
        row: {
          ...firstRelease,
          id: "00000000-0000-7000-8000-000000000002",
          target_app_version: "2.0.0",
        },
      },
      scope,
    });

    expect(result.catalog).toMatchObject({
      catalog_id: winningCatalogId,
      generation: 2,
    });
    expect(JSON.parse(result.catalog.payload).releaseDescriptors).toHaveLength(
      2,
    );
  });

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
            archive_byte_size: 3_000_000_001,
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
      catalog_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
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
      catalog_id: inserted.catalog.catalog_id,
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
      catalog_id: inserted.catalog.catalog_id,
      generation: 3,
      is_tombstone: true,
    });
    expect(await database.models.releases.findById(release.id)).toBeNull();

    const rebuilt = await rebuildReleaseCatalog({ database, scope });
    expect(rebuilt.changed).toBe(false);
    expect(rebuilt.catalog.catalog_id).toBe(inserted.catalog.catalog_id);

    await database.models.channels.delete({ id: scope.channelId });
    await database.models.channels.insert({
      row: { id: scope.channelId, name: scope.channelName },
      onConflict: "returnExisting",
    });
    const recreated = await commitReleaseCatalogMutation({
      database,
      mutation: { operation: "insert", row: release },
      scope,
    });
    expect(recreated.catalog).toMatchObject({
      catalog_id: inserted.catalog.catalog_id,
      generation: 4,
    });
    await database.commit({
      changes: [
        {
          model: "releaseCatalogs",
          operation: "put",
          row: {
            ...recreated.catalog,
            payload: "{}",
          },
        },
      ],
    });
    const repaired = await rebuildReleaseCatalog({ database, scope });
    expect(repaired.changed).toBe(true);
    expect(repaired.catalog).toMatchObject({
      catalog_id: inserted.catalog.catalog_id,
      generation: 5,
    });
  });

  it("does not invent a new identity when a catalog row is lost", async () => {
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
            archive_byte_size: 3_000_000_001,
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

    await expect(
      rebuildReleaseCatalog({ database, scope, updatedAtMs: 2 }),
    ).rejects.toMatchObject({ code: "CATALOG_IDENTITY_MISSING" });
    await expect(
      preflightReleaseCatalogRebuild({ database, scope }),
    ).rejects.toMatchObject({ code: "CATALOG_IDENTITY_MISSING" });
    await expect(
      commitReleaseCatalogMutation({
        database,
        scope,
        mutation: {
          operation: "update",
          id: release.id,
          update: { enabled: false },
        },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_IDENTITY_MISSING" });
    await expect(
      database.models.releases.findById(release.id),
    ).resolves.toEqual(release);
    await expect(
      database.models.releaseCatalogs.findByScopeKey(scope.scopeKey),
    ).resolves.toBeNull();
  });

  it("leaves the previous projection untouched when compilation is oversized", async () => {
    const database = createMemoryDatabasePlugin();
    const fingerprintScope = {
      ...scope,
      fingerprintHash: "fingerprint-a",
      scopeKey: "v1:fingerprint:ios:cHJvZHVjdGlvbg:fingerprint-a",
      strategy: "FINGERPRINT",
    } as const;
    await database.models.channels.insert({
      onConflict: "returnExisting",
      row: { id: scope.channelId, name: scope.channelName },
    });
    const seededBundles = Array.from({ length: 20_000 }, (_, index) => ({
      asset_base_storage_uri: null,
      archive_byte_size: 3_000_000_001 + index,
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
      catalog_id: "01900000-0000-7000-8000-000000000010",
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
