import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";

import {
  blobDatabaseRevisionSnapshotKey,
  parseBlobDatabasePointer,
} from "./blobDatabaseRevision";
import { parseBlobDatabaseSnapshot } from "./blobDatabaseSnapshot";
import {
  BLOB_DATABASE_SNAPSHOT_KEY,
  createBlobDatabaseAdapter,
} from "./createBlobDatabaseAdapter";
import { createDatabaseClient } from "./databaseClient";

const bundleId = "00000000-0000-0000-0000-000000000001";
const commonBundleRow = {
  id: bundleId,
  platform: "ios" as const,
  should_force_update: false,
  enabled: true,
  file_hash: "hash-1",
  git_commit_hash: null,
  message: "bundle-1",
  storage_uri: "storage://bundles/1.zip",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: {},
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
};

describe("blob snapshot compatibility", () => {
  it("keeps direct bundle channel strings", () => {
    const snapshot = parseBlobDatabaseSnapshot({
      version: 2,
      bundles: [{ ...commonBundleRow, channel: "production" }],
      bundle_patches: [],
    });

    expect(snapshot.bundles[0]).toMatchObject({
      channel: "production",
    });
  });

  it("reads and rewrites the direct-channel v2 shape", async () => {
    // Given
    const store = new Map<string, unknown>([
      [
        BLOB_DATABASE_SNAPSHOT_KEY,
        {
          version: 2,
          bundles: [{ ...commonBundleRow, channel: "production" }],
          bundle_patches: [],
        },
      ],
    ]);
    const adapter = createBlobDatabaseAdapter({
      name: "compatibility-memory",
      adapter: () => ({
        apiBasePath: "/api/check-update",
        listObjects: async (prefix) =>
          [...store.keys()].filter((key) => key.startsWith(prefix)),
        loadObject: async (key) => store.get(key) ?? null,
        uploadObject: async (key, value) => void store.set(key, value),
        compareAndSwapObject: async (key, expected, value) => {
          if (
            JSON.stringify(store.get(key) ?? null) !== JSON.stringify(expected)
          ) {
            return false;
          }
          store.set(key, value);
          return true;
        },
        invalidatePaths: async () => undefined,
      }),
    });

    // When
    const bundle = await createDatabaseClient(adapter).getBundleById(bundleId);
    await adapter.create({
      model: "bundles",
      data: {
        ...commonBundleRow,
        id: `${bundleId}-staging`,
        channel: "staging",
      },
    });

    // Then
    expect(bundle?.channel).toBe("production");
    const pointer = parseBlobDatabasePointer(
      store.get(BLOB_DATABASE_SNAPSHOT_KEY),
    );
    expect(
      store.get(blobDatabaseRevisionSnapshotKey(pointer.active_revision)),
    ).toEqual({
      version: 2,
      bundles: [
        {
          ...commonBundleRow,
          channel: "production",
        },
        {
          ...commonBundleRow,
          id: `${bundleId}-staging`,
          channel: "staging",
        },
      ],
      bundle_patches: [],
      bundle_events: [],
    });
  });

  it("serves update checks from flat legacy manifests", async () => {
    const legacyBundle = {
      id: bundleId,
      platform: "ios",
      shouldForceUpdate: false,
      enabled: true,
      fileHash: "hash-1",
      gitCommitHash: null,
      message: "bundle-1",
      channel: "production",
      storageUri: "storage://bundles/1.zip",
      targetAppVersion: "1.0.0",
      fingerprintHash: null,
      metadata: {},
    } satisfies Bundle;
    const store = new Map<string, unknown>([
      ["production/ios/target-app-versions.json", ["1.0.0"]],
      ["production/ios/1.0.0/update.json", [legacyBundle]],
    ]);
    const adapter = createBlobDatabaseAdapter({
      name: "legacy-manifest-memory",
      adapter: () => ({
        apiBasePath: "/api/check-update",
        listObjects: async (prefix) =>
          [...store.keys()].filter((key) => key.startsWith(prefix)),
        loadObject: async (key) => store.get(key) ?? null,
        uploadObject: async (key, value) => void store.set(key, value),
        compareAndSwapObject: async (key, expected, value) => {
          if (
            JSON.stringify(store.get(key) ?? null) !== JSON.stringify(expected)
          ) {
            return false;
          }
          store.set(key, value);
          return true;
        },
        invalidatePaths: async () => undefined,
      }),
    });

    await expect(
      adapter.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        platform: "ios",
      }),
    ).resolves.toMatchObject({ id: bundleId, status: "UPDATE" });
  });
});
