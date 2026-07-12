import type { BundleRow } from "@hot-updater/plugin-core";
import {
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  setupDatabaseAdapterTestSuite,
  setupDatabaseClientTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import { beforeEach, describe, expect, it } from "vitest";

import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { firebaseDatabase } from "./firebaseDatabase";

const PROJECT_ID = "firebase-database-test";

const {
  bundlePatchesCollection,
  bundlesCollection,
  channelsCollection,
  clearCollections,
} = createFirestoreMock(PROJECT_ID);

const createAdapter = (): DatabasePlugin =>
  firebaseDatabase({
    projectId: PROJECT_ID,
    storageBucket: `${PROJECT_ID}.appspot.com`,
  });

setupDatabaseAdapterTestSuite({
  name: "firebase database adapter v2",
  createAdapter,
  migrate: () => undefined,
  reset: clearCollections,
  dispose: () => undefined,
  capabilities: { getUpdateInfo: true, transaction: true },
});

setupDatabaseClientTestSuite({
  name: "firebase database aggregate client",
  createAdapter,
  createClient: createDatabaseClient,
  migrate: () => undefined,
  reset: clearCollections,
  dispose: () => undefined,
});

setupGetUpdateInfoTestSuite({
  getUpdateInfo: async (bundles, args) => {
    await clearCollections();
    const adapter = createAdapter();
    const client = createDatabaseClient(adapter);
    for (const bundle of bundles) {
      await client.insertBundle(bundle);
    }
    return adapter.getUpdateInfo?.(args) ?? null;
  },
});

const legacyRow = (id: string, channel = "production"): BundleRow => ({
  id,
  platform: "ios",
  should_force_update: false,
  enabled: true,
  file_hash: `hash-${id}`,
  git_commit_hash: null,
  message: null,
  channel,
  storage_uri: `gs://bucket/${id}.zip`,
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: {},
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

describe("firebase v1 data migration", () => {
  beforeEach(clearCollections);

  it("backfills channels and splits inline patches into fixed collections", async () => {
    const base = legacyRow("legacy-base");
    const target = legacyRow("legacy-target");
    await bundlesCollection.doc(base.id).set(base);
    await bundlesCollection.doc(target.id).set({
      ...target,
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.file_hash,
          patchFileHash: "patch-hash",
          patchStorageUri: "gs://bucket/patch.bin",
        },
      ],
    });

    const adapter = createAdapter();
    const patches = await adapter.findMany({ model: "bundle_patches" });

    expect(patches).toEqual([
      {
        id: `${target.id}:${base.id}`,
        bundle_id: target.id,
        base_bundle_id: base.id,
        base_file_hash: base.file_hash,
        patch_file_hash: "patch-hash",
        patch_storage_uri: "gs://bucket/patch.bin",
        order_index: 0,
      },
    ]);
    await expect(
      channelsCollection.doc("production").get(),
    ).resolves.toMatchObject({ exists: true });
    await expect(
      bundlePatchesCollection.doc(`${target.id}:${base.id}`).get(),
    ).resolves.toMatchObject({ exists: true });
    const migratedTarget = await bundlesCollection.doc(target.id).get();
    expect(migratedTarget.data()).not.toHaveProperty("patches");
  });

  it("rejects an existing patch whose owner or base bundle is missing", async () => {
    await bundlePatchesCollection.doc("orphan").set({
      id: "orphan",
      bundle_id: "missing-owner",
      base_bundle_id: "missing-base",
      base_file_hash: "base-hash",
      patch_file_hash: "patch-hash",
      patch_storage_uri: "gs://bucket/patch.bin",
      order_index: 0,
    });

    const adapter = createAdapter();

    await expect(adapter.findMany({ model: "bundle_patches" })).rejects.toThrow(
      "bundle_patches.bundle_id.foreign-key",
    );
  });
});
