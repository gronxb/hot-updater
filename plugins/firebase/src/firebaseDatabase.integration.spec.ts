import {
  createDatabaseClient,
  databaseAnalyticsSupport,
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
  bundleEventsCollection,
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

it("advertises Analytics support", () => {
  const plugin = createPlugin();

  expect(plugin[databaseAnalyticsSupport]).toBe(true);
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

const bundleEventFixture = (id: string) => ({
  id,
  type: "UNCHANGED" as const,
  install_id: "install-1",
  user_id: null,
  username: null,
  from_bundle_id: null,
  to_bundle_id: "bundle-1",
  platform: "ios" as const,
  app_version: "1.0.0",
  channel: "production",
  cohort: "stable",
  update_strategy: null,
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: 100,
});

describe("firebase v1 data migration", () => {
  beforeEach(clearCollections);

  it("splits inline patches into fixed collections", async () => {
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

  it("preserves bundle event CRUD inside explicit transactions", async () => {
    const plugin = createPlugin();
    await plugin.create({
      model: "bundle_events",
      data: bundleEventFixture("event-existing"),
    });
    expect(plugin.transaction).toBeDefined();

    const result = await plugin.transaction?.(async (database) => {
      const before = await database.count({ model: "bundle_events" });
      await database.create({
        model: "bundle_events",
        data: bundleEventFixture("event-new"),
      });
      const after = await database.findMany({
        model: "bundle_events",
        limit: 10,
        offset: 0,
      });
      return { before, ids: after.map(({ id }) => id).toSorted() };
    });

    expect(result).toEqual({
      before: 1,
      ids: ["event-existing", "event-new"],
    });
    await expect(
      bundleEventsCollection.doc("event-new").get(),
    ).resolves.toMatchObject({ exists: true });
  });

  it("appends bundle events without a full-database transaction", async () => {
    const plugin = createPlugin();
    const runTransaction = vi.spyOn(firestore, "runTransaction");

    try {
      await plugin.create({
        model: "bundle_events",
        data: bundleEventFixture("event-direct"),
      });

      expect(runTransaction).not.toHaveBeenCalled();
      await expect(
        bundleEventsCollection.doc("event-direct").get(),
      ).resolves.toMatchObject({ exists: true });
    } finally {
      runTransaction.mockRestore();
    }
  });

  it("reads bundle events without loading unrelated collections", async () => {
    const plugin = createPlugin();
    await plugin.create({
      model: "bundle_events",
      data: bundleEventFixture("event-bounded"),
    });
    const collectionPrototype = Object.getPrototypeOf(bundleEventsCollection);
    const queryPrototype = Object.getPrototypeOf(collectionPrototype);
    const get = vi.spyOn(queryPrototype, "get");

    try {
      const rows = await plugin.findMany({
        model: "bundle_events",
        limit: 1,
        sortBy: { field: "id", direction: "asc" },
      });

      expect(rows).toMatchObject([{ id: "event-bounded" }]);
      expect(get).toHaveBeenCalledOnce();
    } finally {
      get.mockRestore();
    }
  });

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
