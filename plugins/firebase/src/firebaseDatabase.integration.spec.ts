import {
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  setupDatabasePluginTestSuite,
  setupDatabaseClientTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { firebaseDatabase } from "./firebaseDatabase";

const PROJECT_ID = "firebase-database-test";

const {
  bundlePatchesCollection,
  bundlesCollection,
  clearCollections,
  firestore,
  settingsCollection,
} = createFirestoreMock(PROJECT_ID);

const createPlugin = (): DatabasePlugin =>
  firebaseDatabase({
    projectId: PROJECT_ID,
    storageBucket: `${PROJECT_ID}.appspot.com`,
  });

setupDatabasePluginTestSuite({
  name: "firebase fixed-model database plugin",
  createPlugin,
  migrate: () => undefined,
  reset: clearCollections,
  dispose: () => undefined,
});

setupDatabaseClientTestSuite({
  name: "firebase database aggregate client",
  createPlugin,
  createClient: createDatabaseClient,
  migrate: () => undefined,
  reset: clearCollections,
  dispose: () => undefined,
});

setupGetUpdateInfoTestSuite({
  getUpdateInfo: async (bundles, args) => {
    await clearCollections();
    const plugin = createPlugin();
    const client = createDatabaseClient(plugin);
    for (const bundle of bundles) {
      await client.insertBundle(bundle);
    }
    return plugin.getUpdateInfo?.(args) ?? null;
  },
});

const legacyRow = (id: string, channel = "production") => ({
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

const bundleFixture = (suffix: string) => ({
  id: `00000000-0000-0000-0000-${suffix.padStart(12, "0")}`,
  platform: "ios" as const,
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${suffix}`,
  gitCommitHash: null,
  message: `bundle-${suffix}`,
  channel: "production",
  storageUri: `storage://bundles/${suffix}.zip`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  metadata: { app_version: suffix },
});

describe("firebase fixed-model document updates", () => {
  beforeEach(clearCollections);

  it("preserves an extension field when updating a bundle message", async () => {
    const bundle = bundleFixture("extension-field");
    const client = createDatabaseClient(createPlugin());
    await client.insertBundle(bundle);
    await bundlesCollection.doc(bundle.id).update({
      extension_field: { version: "future" },
    });

    await client.updateBundleById(bundle.id, {
      message: "updated-message",
    });

    const stored = await bundlesCollection.doc(bundle.id).get();
    expect(stored.data()).toMatchObject({
      extension_field: { version: "future" },
      message: "updated-message",
    });
  });
});

describe("firebase v1 data migration", () => {
  beforeEach(clearCollections);

  it("rejects a future adapter version before reading database collections", async () => {
    const marker = { version: 3, future_option: "preserve-me" };
    await settingsCollection.doc("database_adapter_version").set(marker);
    const bundlesRead = vi.spyOn(bundlesCollection, "get");
    const patchesRead = vi.spyOn(bundlePatchesCollection, "get");
    const plugin = createPlugin();

    await expect(plugin.findMany({ model: "bundles" })).rejects.toThrow(
      "Unsupported Firebase database adapter version: 3",
    );
    expect(bundlesRead).not.toHaveBeenCalled();
    expect(patchesRead).not.toHaveBeenCalled();
    const storedMarker = await settingsCollection
      .doc("database_adapter_version")
      .get();
    expect(storedMarker.exists).toBe(true);
    expect(storedMarker.data()).toEqual(marker);
    bundlesRead.mockRestore();
    patchesRead.mockRestore();
  });

  it("splits inline patches into fixed collections", async () => {
    await settingsCollection.doc("database_adapter_version").set({
      version: 1,
    });
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

    const plugin = createPlugin();
    const patches = await plugin.findMany({ model: "bundle_patches" });

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
      bundlePatchesCollection.doc(`${target.id}:${base.id}`).get(),
    ).resolves.toMatchObject({ exists: true });
    const migratedTarget = await bundlesCollection.doc(target.id).get();
    expect(migratedTarget.data()).toMatchObject({
      channel: "production",
    });
    expect(migratedTarget.data()).not.toHaveProperty("patches");
  });

  it("migrates v1 scalar patches and removes their legacy fields", async () => {
    await settingsCollection.doc("database_adapter_version").set({
      version: 1,
    });
    const base = legacyRow("legacy-scalar-base");
    const target = legacyRow("legacy-scalar-target");
    await bundlesCollection.doc(base.id).set(base);
    await bundlesCollection.doc(target.id).set({
      ...target,
      patch_base_bundle_id: base.id,
      patch_base_file_hash: base.file_hash,
      patch_file_hash: "scalar-patch-hash",
      patch_storage_uri: "gs://bucket/scalar-patch.bin",
    });

    const patches = await createPlugin().findMany({
      model: "bundle_patches",
    });

    expect(patches).toEqual([
      {
        id: `${target.id}:${base.id}`,
        bundle_id: target.id,
        base_bundle_id: base.id,
        base_file_hash: base.file_hash,
        patch_file_hash: "scalar-patch-hash",
        patch_storage_uri: "gs://bucket/scalar-patch.bin",
        order_index: 0,
      },
    ]);
    const migratedTarget = await bundlesCollection.doc(target.id).get();
    for (const field of [
      "patches",
      "patch_base_bundle_id",
      "patch_base_file_hash",
      "patch_file_hash",
      "patch_storage_uri",
    ]) {
      expect(migratedTarget.data()).not.toHaveProperty(field);
    }
    const version = await settingsCollection
      .doc("database_adapter_version")
      .get();
    expect(version.data()).toEqual({ version: 2 });
  });

  it.each(["inline", "scalar"] as const)(
    "rejects a conflicting existing patch before removing %s legacy data",
    async (shape) => {
      await settingsCollection.doc("database_adapter_version").set({
        version: 1,
      });
      const base = legacyRow(`legacy-conflict-${shape}-base`);
      const target = legacyRow(`legacy-conflict-${shape}-target`);
      const legacyFields =
        shape === "inline"
          ? {
              patches: [
                {
                  baseBundleId: base.id,
                  baseFileHash: base.file_hash,
                  patchFileHash: "legacy-patch-hash",
                  patchStorageUri: "gs://bucket/legacy-patch.bin",
                },
              ],
            }
          : {
              patch_base_bundle_id: base.id,
              patch_base_file_hash: base.file_hash,
              patch_file_hash: "legacy-patch-hash",
              patch_storage_uri: "gs://bucket/legacy-patch.bin",
            };
      const patchId = `${target.id}:${base.id}`;
      const conflictingPatch = {
        id: patchId,
        bundle_id: target.id,
        base_bundle_id: base.id,
        base_file_hash: base.file_hash,
        patch_file_hash: "conflicting-patch-hash",
        patch_storage_uri: "gs://bucket/conflicting-patch.bin",
        order_index: 0,
      };
      await bundlesCollection.doc(base.id).set(base);
      await bundlesCollection.doc(target.id).set({
        ...target,
        ...legacyFields,
      });
      await bundlePatchesCollection.doc(patchId).set(conflictingPatch);

      await expect(
        createPlugin().findMany({ model: "bundles" }),
      ).rejects.toThrow("bundle_patches.id.conflict");

      const [storedTarget, storedPatch, storedVersion] = await Promise.all([
        bundlesCollection.doc(target.id).get(),
        bundlePatchesCollection.doc(patchId).get(),
        settingsCollection.doc("database_adapter_version").get(),
      ]);
      expect(storedTarget.data()).toMatchObject(legacyFields);
      expect(storedPatch.data()).toEqual(conflictingPatch);
      expect(storedVersion.data()).toEqual({ version: 1 });
    },
  );

  it("adopts an identical existing patch before removing legacy data", async () => {
    await settingsCollection.doc("database_adapter_version").set({
      version: 1,
    });
    const base = legacyRow("legacy-identical-base");
    const target = legacyRow("legacy-identical-target");
    const patch = {
      id: `${target.id}:${base.id}`,
      bundle_id: target.id,
      base_bundle_id: base.id,
      base_file_hash: base.file_hash,
      patch_file_hash: "identical-patch-hash",
      patch_storage_uri: "gs://bucket/identical-patch.bin",
      order_index: 0,
    };
    await bundlesCollection.doc(base.id).set(base);
    await bundlesCollection.doc(target.id).set({
      ...target,
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: patch.base_file_hash,
          patchFileHash: patch.patch_file_hash,
          patchStorageUri: patch.patch_storage_uri,
        },
      ],
    });
    await bundlePatchesCollection.doc(patch.id).set(patch);

    await expect(
      createPlugin().findMany({ model: "bundle_patches" }),
    ).resolves.toContainEqual(patch);

    const [storedTarget, storedVersion] = await Promise.all([
      bundlesCollection.doc(target.id).get(),
      settingsCollection.doc("database_adapter_version").get(),
    ]);
    expect(storedTarget.data()).not.toHaveProperty("patches");
    expect(storedVersion.data()).toEqual({ version: 2 });
  });

  it("rejects a patch whose document key differs from its row id", async () => {
    await settingsCollection.doc("database_adapter_version").set({
      version: 1,
    });
    const base = legacyRow("legacy-miskeyed-base");
    const target = legacyRow("legacy-miskeyed-target");
    const patches = [
      {
        baseBundleId: base.id,
        baseFileHash: base.file_hash,
        patchFileHash: "miskeyed-patch-hash",
        patchStorageUri: "gs://bucket/miskeyed-patch.bin",
      },
    ];
    await bundlesCollection.doc(base.id).set(base);
    await bundlesCollection.doc(target.id).set({ ...target, patches });
    await bundlePatchesCollection.doc("wrong-document-key").set({
      id: `${target.id}:${base.id}`,
      bundle_id: target.id,
      base_bundle_id: base.id,
      base_file_hash: base.file_hash,
      patch_file_hash: "miskeyed-patch-hash",
      patch_storage_uri: "gs://bucket/miskeyed-patch.bin",
      order_index: 0,
    });

    await expect(createPlugin().findMany({ model: "bundles" })).rejects.toThrow(
      "bundle_patches.id.document-key",
    );

    const [storedTarget, storedVersion] = await Promise.all([
      bundlesCollection.doc(target.id).get(),
      settingsCollection.doc("database_adapter_version").get(),
    ]);
    expect(storedTarget.data()).toMatchObject({ patches });
    expect(storedVersion.data()).toEqual({ version: 1 });
  });

  it("rejects a bundle whose document key differs from its row id before migration writes", async () => {
    await settingsCollection.doc("database_adapter_version").set({
      version: 1,
    });
    const bundle = legacyRow("legacy-miskeyed-bundle");
    await bundlesCollection.doc("wrong-document-key").set(bundle);

    await expect(createPlugin().findMany({ model: "bundles" })).rejects.toThrow(
      "bundles.id.document-key",
    );

    const [storedBundle, canonicalBundle, storedVersion] = await Promise.all([
      bundlesCollection.doc("wrong-document-key").get(),
      bundlesCollection.doc(bundle.id).get(),
      settingsCollection.doc("database_adapter_version").get(),
    ]);
    expect(storedBundle.data()).toEqual(bundle);
    expect(canonicalBundle.exists).toBe(false);
    expect(storedVersion.data()).toEqual({ version: 1 });
  });

  it("rejects duplicate embedded bundle ids before deleting version 2 data", async () => {
    await settingsCollection.doc("database_adapter_version").set({
      version: 2,
    });
    const bundle = legacyRow("duplicate-embedded-bundle");
    await bundlesCollection.doc(bundle.id).set(bundle);
    await bundlesCollection.doc("duplicate-document-key").set(bundle);

    await expect(
      createPlugin().delete({
        model: "bundles",
        where: [{ field: "id", value: bundle.id }],
      }),
    ).rejects.toThrow("bundles.id.unique");

    const [canonicalBundle, duplicateBundle, storedVersion] = await Promise.all(
      [
        bundlesCollection.doc(bundle.id).get(),
        bundlesCollection.doc("duplicate-document-key").get(),
        settingsCollection.doc("database_adapter_version").get(),
      ],
    );
    expect(canonicalBundle.data()).toEqual(bundle);
    expect(duplicateBundle.data()).toEqual(bundle);
    expect(storedVersion.data()).toEqual({ version: 2 });
  });

  it("rejects a miskeyed version 2 patch before deleting any data", async () => {
    await settingsCollection.doc("database_adapter_version").set({
      version: 2,
    });
    const base = legacyRow("version-2-miskeyed-base");
    const target = legacyRow("version-2-miskeyed-target");
    const patch = {
      id: `${target.id}:${base.id}`,
      bundle_id: target.id,
      base_bundle_id: base.id,
      base_file_hash: base.file_hash,
      patch_file_hash: "version-2-patch-hash",
      patch_storage_uri: "gs://bucket/version-2-patch.bin",
      order_index: 0,
    };
    await bundlesCollection.doc(base.id).set(base);
    await bundlesCollection.doc(target.id).set(target);
    await bundlePatchesCollection.doc("wrong-document-key").set(patch);

    await expect(
      createPlugin().delete({
        model: "bundle_patches",
        where: [{ field: "id", value: patch.id }],
      }),
    ).rejects.toThrow("bundle_patches.id.document-key");

    const [storedPatch, canonicalPatch, storedVersion] = await Promise.all([
      bundlePatchesCollection.doc("wrong-document-key").get(),
      bundlePatchesCollection.doc(patch.id).get(),
      settingsCollection.doc("database_adapter_version").get(),
    ]);
    expect(storedPatch.data()).toEqual(patch);
    expect(canonicalPatch.exists).toBe(false);
    expect(storedVersion.data()).toEqual({ version: 2 });
  });

  it("migrates legacy rows with bounded batches instead of a transaction", async () => {
    const bundle = legacyRow("legacy-batched");
    await bundlesCollection.doc(bundle.id).set(bundle);
    const runTransaction = vi.spyOn(firestore, "runTransaction");

    await createPlugin().findMany({ model: "bundles" });

    expect(runTransaction).not.toHaveBeenCalled();
    await expect(
      settingsCollection.doc("database_adapter_version").get(),
    ).resolves.toMatchObject({ exists: true });
    runTransaction.mockRestore();
  });

  it("converges concurrent cold-start migrations", async () => {
    const bundle = legacyRow("legacy-concurrent");
    await bundlesCollection.doc(bundle.id).set(bundle);

    await Promise.all([
      createPlugin().findMany({ model: "bundles" }),
      createPlugin().findMany({ model: "bundles" }),
    ]);

    const migrated = await bundlesCollection.doc(bundle.id).get();
    expect(migrated.data()).toMatchObject({
      channel: "production",
    });
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

    const plugin = createPlugin();

    await expect(plugin.findMany({ model: "bundle_patches" })).rejects.toThrow(
      "bundle_patches.bundle_id.foreign-key",
    );
  });
});

describe("firebase bounded reads", () => {
  beforeEach(clearCollections);

  it("ignores unrelated malformed documents during an update check", async () => {
    const plugin = createPlugin();
    const client = createDatabaseClient(plugin);
    const value = {
      ...bundleFixture("991"),
      fingerprintHash: "fingerprint-991",
      targetAppVersion: null,
    };
    await client.insertBundle(value);
    await bundlesCollection.doc("unrelated-malformed").set({
      channel: "other",
      platform: "android",
      enabled: true,
      fingerprint_hash: "other-fingerprint",
    });

    await expect(
      plugin.getUpdateInfo?.({
        _updateStrategy: "fingerprint",
        platform: "ios",
        bundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        fingerprintHash: "fingerprint-991",
      }),
    ).resolves.toMatchObject({ id: value.id, status: "UPDATE" });
  });

  it("uses an exact document read without parsing unrelated bundles", async () => {
    const plugin = createPlugin();
    const client = createDatabaseClient(plugin);
    const value = bundleFixture("992");
    await client.insertBundle(value);
    await bundlesCollection.doc("unrelated-malformed").set({
      channel: "other",
    });

    await expect(
      createPlugin().findOne({
        model: "bundles",
        where: [{ field: "id", value: value.id }],
      }),
    ).resolves.toMatchObject({ id: value.id, channel: "production" });
  });

  it("rejects a requested document whose key differs from its row id", async () => {
    await settingsCollection.doc("database_adapter_version").set({
      version: 2,
    });
    const documentKey = "requested-document-key";
    await bundlesCollection
      .doc(documentKey)
      .set(legacyRow("different-embedded-id"));

    await expect(
      createPlugin().findOne({
        model: "bundles",
        where: [{ field: "id", value: documentKey }],
      }),
    ).rejects.toThrow("bundles.id.document-key");
  });

  it("rejects a matching update-check row whose key differs from its id", async () => {
    await settingsCollection.doc("database_adapter_version").set({
      version: 2,
    });
    await bundlesCollection
      .doc("wrong-update-document-key")
      .set(legacyRow("00000000-0000-0000-0000-000000000994"));

    await expect(
      createPlugin().getUpdateInfo?.({
        _updateStrategy: "appVersion",
        platform: "ios",
        bundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        appVersion: "1.0.0",
      }),
    ).rejects.toThrow("bundles.id.document-key");
  });

  it("loads update-check relations from one read-only snapshot", async () => {
    const plugin = createPlugin();
    const client = createDatabaseClient(plugin);
    const value = bundleFixture("993");
    await client.insertBundle(value);
    const runTransaction = vi.spyOn(firestore, "runTransaction");

    try {
      await expect(
        plugin.getUpdateInfo?.({
          _updateStrategy: "appVersion",
          platform: "ios",
          bundleId: "00000000-0000-0000-0000-000000000000",
          channel: "production",
          appVersion: "1.0.0",
        }),
      ).resolves.toMatchObject({ id: value.id, status: "UPDATE" });
      expect(runTransaction).toHaveBeenCalledWith(expect.any(Function), {
        readOnly: true,
      });
    } finally {
      runTransaction.mockRestore();
    }
  });
});
