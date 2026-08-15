import type { Bundle } from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  blobDatabaseRevisionManifestPrefix,
  blobDatabaseRevisionSnapshotKey,
  parseBlobDatabasePointer,
} from "./blobDatabaseRevision";
import {
  BLOB_DATABASE_SNAPSHOT_KEY,
  createBlobDatabasePlugin,
  type BlobInvalidationFailure,
} from "./createBlobDatabasePlugin";
import { createDatabaseClient } from "./databaseClient";
import type { BundleRow, BundleRowUpdate, DatabasePlugin } from "./types";

type MemoryConfig = {
  readonly store: Map<string, unknown>;
  readonly failNextUpload: () => boolean;
  readonly invalidations: string[][];
  readonly invalidatePaths?: (paths: readonly string[]) => Promise<void>;
  readonly onInvalidationError?: (
    failure: BlobInvalidationFailure,
  ) => void | Promise<void>;
  readonly onLoadObject?: (key: string) => void;
  readonly onSnapshotRead?: () => void;
};

const createMemoryPlugin = (config: MemoryConfig) =>
  createBlobDatabasePlugin({
    name: "memoryBlobDatabase",
    plugin: () => ({
      apiBasePath: "/api/check-update",
      listObjects: async (prefix) =>
        [...config.store.keys()].filter((key) => key.startsWith(prefix)),
      loadObject: async (key) => {
        config.onLoadObject?.(key);
        if (key === BLOB_DATABASE_SNAPSHOT_KEY) config.onSnapshotRead?.();
        return config.store.get(key) ?? null;
      },
      uploadObject: async (key, data) => {
        if (config.failNextUpload()) {
          throw new Error("fixture upload failure");
        }
        config.store.set(key, data);
      },
      compareAndSwapObject: async (key, expected, data) => {
        if (key === BLOB_DATABASE_SNAPSHOT_KEY) config.onSnapshotRead?.();
        if (config.failNextUpload()) {
          throw new Error("fixture upload failure");
        }
        const current = config.store.get(key) ?? null;
        if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
        config.store.set(key, data);
        return true;
      },
      invalidatePaths:
        config.invalidatePaths ??
        (async (paths) => {
          config.invalidations.push([...paths]);
        }),
      onInvalidationError: config.onInvalidationError,
    }),
  });

const insertBundleRow = (plugin: DatabasePlugin, row: BundleRow) =>
  plugin.commit({
    changes: [
      {
        model: "channels",
        operation: "insert",
        row: { id: row.channel_id, name: row.channel },
        onConflict: "ignore",
      },
      { model: "bundles", operation: "insert", row },
    ],
  });

const updateBundleRow = (
  plugin: DatabasePlugin,
  id: string,
  update: BundleRowUpdate,
) =>
  plugin.commit({
    changes: [{ model: "bundles", operation: "update", where: { id }, update }],
  });

const store = new Map<string, unknown>();
const invalidations: string[][] = [];
let uploadShouldFail = false;

const config = (): MemoryConfig => ({
  store,
  invalidations,
  failNextUpload: () => {
    const result = uploadShouldFail;
    uploadShouldFail = false;
    return result;
  },
});

beforeEach(() => {
  store.clear();
  invalidations.length = 0;
  uploadShouldFail = false;
});

const activeRevision = (): string =>
  parseBlobDatabasePointer(store.get(BLOB_DATABASE_SNAPSHOT_KEY))
    .active_revision;

const activeSnapshot = (): unknown =>
  store.get(blobDatabaseRevisionSnapshotKey(activeRevision()));

const activeManifest = (key: string): unknown =>
  store.get(`${blobDatabaseRevisionManifestPrefix(activeRevision())}/${key}`);

describe("blob snapshot persistence", () => {
  it("returns one canonical channel row for concurrent name inserts", async () => {
    const firstPlugin = createMemoryPlugin(config());
    const secondPlugin = createMemoryPlugin(config());
    const first = { id: "channel-1", name: "production" };
    const second = { id: "channel-2", name: "production" };

    const results = await Promise.all([
      firstPlugin.models.channels.insert({
        row: first,
        onConflict: "returnExisting",
      }),
      secondPlugin.models.channels.insert({
        row: second,
        onConflict: "returnExisting",
      }),
    ]);

    expect(results.filter(({ inserted }) => inserted)).toHaveLength(1);
    expect(results[0]?.row).toEqual(results[1]?.row);
    await expect(firstPlugin.models.channels.list({})).resolves.toEqual({
      channels: [results[0]!.row],
    });
  });

  it("rolls back a channel inserted before an invalid bundle", async () => {
    const plugin = createMemoryPlugin(config());
    const row = {
      ...bundleRow("9"),
      target_app_version: null,
      fingerprint_hash: null,
    };

    await expect(
      plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "insert",
            row: { id: row.channel_id, name: row.channel },
            onConflict: "ignore",
          },
          { model: "bundles", operation: "insert", row },
        ],
      }),
    ).rejects.toThrow();
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [],
    });
    await expect(plugin.models.bundles.findById(row.id)).resolves.toBeNull();
  });

  it("deletes only empty channels and reports stable outcomes", async () => {
    const plugin = createMemoryPlugin(config());
    const channel = { id: "channel-preview", name: "preview" };
    await plugin.models.channels.insert({
      row: channel,
      onConflict: "returnExisting",
    });

    await expect(
      plugin.models.channels.delete({ id: "missing-channel" }),
    ).resolves.toEqual({ deleted: false, reason: "not_found" });
    await expect(
      plugin.models.channels.delete({ id: channel.id }),
    ).resolves.toEqual({ deleted: true });
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [],
    });
  });

  it("rejects deleting a referenced channel without changing the snapshot", async () => {
    const plugin = createMemoryPlugin(config());
    const row = bundleRow("10");
    await insertBundleRow(plugin, row);
    const pointerBefore = store.get(BLOB_DATABASE_SNAPSHOT_KEY);

    await expect(
      plugin.models.channels.delete({ id: row.channel_id }),
    ).resolves.toEqual({ deleted: false, reason: "not_empty" });
    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toBe(pointerBefore);
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [{ id: row.channel_id, name: row.channel }],
    });
    await expect(plugin.models.bundles.findById(row.id)).resolves.toEqual(row);
  });

  it("returns an indexed referenced conflict and rolls back prior changes", async () => {
    const plugin = createMemoryPlugin(config());
    const row = bundleRow("11");
    await insertBundleRow(plugin, row);

    await expect(
      plugin.commit({
        changes: [
          {
            model: "bundles",
            operation: "update",
            where: { id: row.id },
            update: { enabled: false },
          },
          {
            model: "channels",
            operation: "delete",
            where: { id: row.channel_id },
          },
        ],
      }),
    ).resolves.toEqual({
      committed: false,
      conflict: { changeIndex: 1, reason: "referenced" },
    });
    await expect(plugin.models.bundles.findById(row.id)).resolves.toEqual(row);
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [{ id: row.channel_id, name: row.channel }],
    });
  });

  it("migrates legacy manifests including scalar patch fields", async () => {
    const base = legacyBundle("1");
    const target = {
      ...legacyBundle("2"),
      patchBaseBundleId: base.id,
      patchBaseFileHash: base.fileHash,
      patchFileHash: "legacy-patch-hash",
      patchStorageUri: "storage://patches/legacy.patch",
    } satisfies Bundle;
    store.set("production/ios/1.0.0/update.json", [base, target]);

    const plugin = createMemoryPlugin(config());
    const patches = await plugin.models.bundlePatches.findByBundleIds([
      target.id,
    ]);

    expect(patches).toEqual([
      {
        id: `${target.id}:${base.id}`,
        bundle_id: target.id,
        base_bundle_id: base.id,
        base_file_hash: base.fileHash,
        patch_file_hash: "legacy-patch-hash",
        patch_storage_uri: "storage://patches/legacy.patch",
        order_index: 0,
      },
    ]);
    expect(activeSnapshot()).toMatchObject({
      version: 2,
      bundles: expect.arrayContaining([
        expect.objectContaining({ channel: "production" }),
      ]),
    });
  });

  it("rejects a singleton legacy manifest before publishing V2 data", async () => {
    const key = "production/ios/1.0.0/update.json";
    store.set(key, legacyBundle("1"));
    const previousEntries = [...store.entries()];
    const plugin = createMemoryPlugin(config());

    await expect(
      createDatabaseClient(plugin).insertBundle(legacyBundle("2")),
    ).rejects.toMatchObject({
      name: "BlobDatabaseSnapshotError",
      source: key,
    });

    expect([...store.entries()]).toEqual(previousEntries);
    expect(store.has(BLOB_DATABASE_SNAPSHOT_KEY)).toBe(false);
    expect(invalidations).toEqual([]);
  });

  it("writes deterministic fixed-model snapshots", async () => {
    const plugin = createMemoryPlugin(config());
    await insertBundleRow(plugin, bundleRow("2"));
    await insertBundleRow(plugin, bundleRow("1"));
    await plugin.commit({
      changes: [
        {
          model: "bundles",
          operation: "delete",
          where: { id: fixtureId("1") },
        },
        {
          model: "bundles",
          operation: "delete",
          where: { id: fixtureId("2") },
        },
      ],
    });

    expect(activeSnapshot()).toEqual({
      version: 2,
      bundles: [],
      bundle_patches: [],
      channels: [{ id: channelId("production"), name: "production" }],
      bundle_events: [],
      client_access_keys: [],
    });
  });

  it("keeps the previous snapshot readable after a failed write", async () => {
    const plugin = createMemoryPlugin(config());
    const client = createDatabaseClient(plugin);
    await client.insertBundle(legacyBundle("1"));
    const previous = store.get(BLOB_DATABASE_SNAPSHOT_KEY);
    uploadShouldFail = true;

    await expect(client.insertBundle(legacyBundle("2"))).rejects.toThrow(
      "fixture upload failure",
    );

    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toEqual(previous);
  });

  it("commits and reports once when bounded invalidation retries fail", async () => {
    const invalidationError = new Error("fixture invalidation failure");
    const invalidatePaths = vi.fn(async () => {
      throw invalidationError;
    });
    const onInvalidationError = vi.fn();
    const plugin = createMemoryPlugin({
      ...config(),
      invalidatePaths,
      onInvalidationError,
    });
    const client = createDatabaseClient(plugin);

    await expect(
      client.insertBundle(legacyBundle("1")),
    ).resolves.toBeUndefined();

    const reader = createMemoryPlugin(config());
    await expect(
      reader.models.bundles.findById(fixtureId("1")),
    ).resolves.toMatchObject({ id: fixtureId("1") });
    expect(invalidatePaths).toHaveBeenCalledTimes(3);
    expect(onInvalidationError).toHaveBeenCalledTimes(1);
    expect(onInvalidationError).toHaveBeenCalledWith({
      attempts: 3,
      error: invalidationError,
      paths: expect.arrayContaining([
        "/api/check-update/app-version/ios/1.0.0/production/*",
      ]),
    });
  });

  it.each(["throws", "rejects"] as const)(
    "commits when the invalidation observer $0",
    async (observerBehavior) => {
      const invalidatePaths = vi.fn(async () => {
        throw new Error("fixture invalidation failure");
      });
      const observerError = new Error("fixture observer failure");
      const onInvalidationError =
        observerBehavior === "throws"
          ? vi.fn(() => {
              throw observerError;
            })
          : vi.fn(async () => {
              throw observerError;
            });
      const plugin = createMemoryPlugin({
        ...config(),
        invalidatePaths,
        onInvalidationError,
      });
      const client = createDatabaseClient(plugin);

      await expect(
        client.insertBundle(legacyBundle("1")),
      ).resolves.toBeUndefined();
      expect(invalidatePaths).toHaveBeenCalledTimes(3);
      expect(onInvalidationError).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a corrupt v2 snapshot without replacing it", async () => {
    const corrupt = {
      version: 2,
      bundles: [{ ...bundleRow("1"), channel: undefined }],
      bundle_patches: [],
    };
    store.set(BLOB_DATABASE_SNAPSHOT_KEY, corrupt);
    const plugin = createMemoryPlugin(config());

    await expect(plugin.models.bundles.count()).rejects.toThrow(
      "Invalid blob database data",
    );

    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toBe(corrupt);
  });

  it("invalidates exact, range, and fingerprint update routes", async () => {
    const plugin = createMemoryPlugin(config());
    await insertBundleRow(plugin, bundleRow("1"));
    await insertBundleRow(plugin, {
      ...bundleRow("2"),
      target_app_version: ">=1.0.0 <2.0.0",
    });
    await insertBundleRow(plugin, {
      ...bundleRow("3"),
      target_app_version: null,
      fingerprint_hash: "fingerprint-3",
    });

    expect(invalidations.flat()).toEqual(
      expect.arrayContaining([
        "/api/check-update/app-version/ios/1.0.0/production/*",
        "/api/check-update/app-version/ios/1.0/production/*",
        "/api/check-update/app-version/ios/1/production/*",
        "/api/check-update/app-version/ios/*",
        "/api/check-update/fingerprint/ios/fingerprint-3/production/*",
      ]),
    );
  });

  it("publishes and invalidates both targets for a dual-target bundle", async () => {
    const plugin = createMemoryPlugin(config());
    const bundle = {
      ...legacyBundle("7"),
      fingerprintHash: "fingerprint-7",
    };

    await createDatabaseClient(plugin).insertBundle(bundle);

    expect(
      activeManifest("app-version/production/ios/1.0.0/update.json"),
    ).toEqual([expect.objectContaining({ id: bundle.id })]);
    expect(
      activeManifest("fingerprint/production/ios/fingerprint-7/update.json"),
    ).toEqual([expect.objectContaining({ id: bundle.id })]);
    expect(invalidations.flat()).toEqual(
      expect.arrayContaining([
        "/api/check-update/app-version/ios/1.0.0/production/*",
        "/api/check-update/app-version/ios/1.0/production/*",
        "/api/check-update/app-version/ios/1/production/*",
        "/api/check-update/fingerprint/ios/fingerprint-7/production/*",
      ]),
    );
    await expect(
      plugin.queries.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: fixtureId("0"),
        channel: "production",
        platform: "ios",
      }),
    ).resolves.toMatchObject({ id: bundle.id, status: "UPDATE" });
    await expect(
      plugin.queries.getUpdateInfo?.({
        _updateStrategy: "fingerprint",
        bundleId: fixtureId("0"),
        channel: "production",
        fingerprintHash: "fingerprint-7",
        platform: "ios",
      }),
    ).resolves.toMatchObject({ id: bundle.id, status: "UPDATE" });
  });

  it("serves app-version update checks from the active revision", async () => {
    const snapshotRead = vi.fn();
    const plugin = createMemoryPlugin({
      ...config(),
      onSnapshotRead: snapshotRead,
    });
    await createDatabaseClient(plugin).insertBundle(legacyBundle("1"));
    snapshotRead.mockClear();

    await expect(
      plugin.queries.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        platform: "ios",
      }),
    ).resolves.toMatchObject({
      id: fixtureId("1"),
      status: "UPDATE",
    });
    expect(snapshotRead).toHaveBeenCalledTimes(1);
    expect(
      activeManifest("app-version/production/ios/target-app-versions.json"),
    ).toEqual(["1.0.0"]);
    expect(
      activeManifest("app-version/production/ios/1.0.0/update.json"),
    ).toEqual([
      expect.objectContaining({
        channel: "production",
        id: fixtureId("1"),
      }),
    ]);
  });

  it("fails closed when the active revision version index is missing", async () => {
    const plugin = createMemoryPlugin(config());
    await createDatabaseClient(plugin).insertBundle(legacyBundle("1"));
    const prefix = blobDatabaseRevisionManifestPrefix(activeRevision());
    const key = `${prefix}/app-version/production/ios/target-app-versions.json`;
    store.delete(key);
    store.set(`${prefix}/production/ios/target-app-versions.json`, ["1.0.0"]);
    store.set("production/ios/target-app-versions.json", ["1.0.0"]);

    await expect(
      plugin.queries.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: fixtureId("0"),
        channel: "production",
        platform: "ios",
      }),
    ).rejects.toMatchObject({
      name: "BlobDatabaseSnapshotError",
      source: key,
    });
  });

  it("fails closed when an active revision manifest is missing", async () => {
    const plugin = createMemoryPlugin(config());
    await createDatabaseClient(plugin).insertBundle(legacyBundle("1"));
    const prefix = blobDatabaseRevisionManifestPrefix(activeRevision());
    const key = `${prefix}/app-version/production/ios/1.0.0/update.json`;
    store.delete(key);
    store.set(`${prefix}/production/ios/1.0.0/update.json`, [
      legacyBundle("1"),
    ]);
    store.set("production/ios/1.0.0/update.json", [legacyBundle("1")]);

    await expect(
      plugin.queries.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: fixtureId("0"),
        channel: "production",
        platform: "ios",
      }),
    ).rejects.toMatchObject({
      name: "BlobDatabaseSnapshotError",
      source: key,
    });
  });

  it("returns no update when the active revision has no app-version manifest for the route", async () => {
    const plugin = createMemoryPlugin(config());
    await createDatabaseClient(plugin).insertBundle({
      ...legacyBundle("1"),
      channel: "beta",
    });

    await expect(
      plugin.queries.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: fixtureId("0"),
        channel: "production",
        platform: "ios",
      }),
    ).resolves.toBeNull();
  });

  it("returns no update when the active revision has no fingerprint manifest for the route", async () => {
    const plugin = createMemoryPlugin(config());
    await createDatabaseClient(plugin).insertBundle({
      ...legacyBundle("2"),
      targetAppVersion: null,
      fingerprintHash: "different-fingerprint",
    });

    await expect(
      plugin.queries.getUpdateInfo?.({
        _updateStrategy: "fingerprint",
        bundleId: fixtureId("0"),
        channel: "production",
        fingerprintHash: "requested-fingerprint",
        platform: "ios",
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when an active revision fingerprint manifest is missing", async () => {
    const plugin = createMemoryPlugin(config());
    await createDatabaseClient(plugin).insertBundle({
      ...legacyBundle("2"),
      targetAppVersion: null,
      fingerprintHash: "fingerprint-2",
    });
    const prefix = blobDatabaseRevisionManifestPrefix(activeRevision());
    const key = `${prefix}/fingerprint/production/ios/fingerprint-2/update.json`;
    store.delete(key);

    await expect(
      plugin.queries.getUpdateInfo?.({
        _updateStrategy: "fingerprint",
        bundleId: fixtureId("0"),
        channel: "production",
        fingerprintHash: "fingerprint-2",
        platform: "ios",
      }),
    ).rejects.toMatchObject({
      name: "BlobDatabaseSnapshotError",
      source: key,
    });
  });

  it("serves fingerprint update checks from the exact manifest", async () => {
    const snapshotRead = vi.fn();
    const plugin = createMemoryPlugin({
      ...config(),
      onSnapshotRead: snapshotRead,
    });
    const bundle = {
      ...legacyBundle("2"),
      targetAppVersion: null,
      fingerprintHash: "fingerprint-2",
    };
    await createDatabaseClient(plugin).insertBundle(bundle);
    snapshotRead.mockClear();

    await expect(
      plugin.queries.getUpdateInfo?.({
        _updateStrategy: "fingerprint",
        bundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        fingerprintHash: "fingerprint-2",
        platform: "ios",
      }),
    ).resolves.toMatchObject({ id: bundle.id, status: "UPDATE" });
    expect(snapshotRead).toHaveBeenCalledTimes(1);
    expect(
      activeManifest("fingerprint/production/ios/fingerprint-2/update.json"),
    ).toEqual([expect.objectContaining({ id: bundle.id })]);
  });

  it("separates app-version and fingerprint manifest namespaces", async () => {
    const plugin = createMemoryPlugin(config());
    await insertBundleRow(plugin, {
      ...bundleRow("4"),
      target_app_version: "fingerprint-4",
    });
    await insertBundleRow(plugin, {
      ...bundleRow("5"),
      target_app_version: null,
      fingerprint_hash: "fingerprint-4",
    });

    expect(
      activeManifest("app-version/production/ios/fingerprint-4/update.json"),
    ).toEqual([expect.objectContaining({ id: fixtureId("4") })]);
    expect(
      activeManifest("fingerprint/production/ios/fingerprint-4/update.json"),
    ).toEqual([expect.objectContaining({ id: fixtureId("5") })]);
  });

  it("rejects unsafe update route segments before snapshot commit", async () => {
    const plugin = createMemoryPlugin(config());

    await expect(
      insertBundleRow(plugin, { ...bundleRow("6"), channel: "release/*" }),
    ).rejects.toMatchObject({
      name: "BlobDatabaseUnsafeRouteSegmentError",
      field: "channel",
      value: "release/*",
    });
    expect(store.size).toBe(0);
    expect(invalidations).toEqual([]);
  });

  it("rejects an empty channel at the database model boundary", async () => {
    const plugin = createMemoryPlugin(config());

    await expect(
      insertBundleRow(plugin, { ...bundleRow("6"), channel: "" }),
    ).rejects.toMatchObject({
      name: "DatabasePluginInputError",
      code: "invalid-data",
    });
    expect(store.size).toBe(0);
    expect(invalidations).toEqual([]);
  });

  it.each([".", "..", "release%2Fcandidate", "release\u0000candidate"])(
    "rejects unsafe channel segment %j before snapshot commit",
    async (channel) => {
      const plugin = createMemoryPlugin(config());

      await expect(
        insertBundleRow(plugin, { ...bundleRow("6"), channel }),
      ).rejects.toMatchObject({
        name: "BlobDatabaseUnsafeRouteSegmentError",
        field: "channel",
        value: channel,
      });
      expect(store.size).toBe(0);
      expect(invalidations).toEqual([]);
    },
  );

  it("rejects unsafe update-check segments before loading blob state", async () => {
    const onLoadObject = vi.fn();
    const plugin = createMemoryPlugin({ ...config(), onLoadObject });

    await expect(
      plugin.queries.getUpdateInfo?.({
        _updateStrategy: "fingerprint",
        bundleId: fixtureId("0"),
        channel: "production",
        fingerprintHash: "unsafe*hash",
        platform: "ios",
      }),
    ).rejects.toMatchObject({
      name: "BlobDatabaseUnsafeRouteSegmentError",
      field: "fingerprintHash",
      value: "unsafe*hash",
    });
    expect(onLoadObject).not.toHaveBeenCalled();
  });

  it("pins one immutable revision for an update check", async () => {
    const writer = createMemoryPlugin(config());
    const client = createDatabaseClient(writer);
    const firstBundle = legacyBundle("1");
    await client.insertBundle(firstBundle);
    const firstPointer = store.get(BLOB_DATABASE_SNAPSHOT_KEY);
    await client.insertBundle(legacyBundle("2"));
    const secondPointer = store.get(BLOB_DATABASE_SNAPSHOT_KEY);
    const firstRevision =
      parseBlobDatabasePointer(firstPointer).active_revision;
    store.set(BLOB_DATABASE_SNAPSHOT_KEY, firstPointer);

    const reader = createMemoryPlugin({
      ...config(),
      onLoadObject: (key) => {
        if (
          key ===
          `${blobDatabaseRevisionManifestPrefix(firstRevision)}/app-version/production/ios/target-app-versions.json`
        ) {
          store.set(BLOB_DATABASE_SNAPSHOT_KEY, secondPointer);
        }
      },
    });

    await expect(
      reader.queries.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        platform: "ios",
      }),
    ).resolves.toMatchObject({ id: firstBundle.id, status: "UPDATE" });
    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toBe(secondPointer);
  });

  it("reloads the latest snapshot written by another plugin instance", async () => {
    const first = createMemoryPlugin(config());
    const second = createMemoryPlugin(config());
    await first.models.bundles.count();

    await insertBundleRow(second, bundleRow("1"));

    await expect(first.models.bundles.count()).resolves.toBe(1);
  });

  it("preserves concurrent writes across plugin instances", async () => {
    const plugins = Array.from({ length: 5 }, () =>
      createMemoryPlugin(config()),
    );

    await Promise.all(
      plugins.map((plugin, index) =>
        insertBundleRow(plugin, bundleRow(String(index + 1))),
      ),
    );

    const reader = plugins[0];
    if (!reader) throw new Error("Expected a concurrent plugin fixture.");
    await expect(reader.models.bundles.count()).resolves.toBe(5);
  });

  it("merges a disjoint concurrent write without rerunning the callback", async () => {
    let snapshotReads = 0;
    const externalSnapshot = {
      version: 2 as const,
      bundles: [bundleRow("2")],
      bundle_patches: [],
    };
    const plugin = createMemoryPlugin({
      ...config(),
      onSnapshotRead: () => {
        snapshotReads += 1;
        if (snapshotReads === 2) {
          store.set(BLOB_DATABASE_SNAPSHOT_KEY, externalSnapshot);
        }
      },
    });
    const mutation = vi.fn(() => insertBundleRow(plugin, bundleRow("1")));

    await expect(mutation()).resolves.toEqual({ committed: true });

    expect(mutation).toHaveBeenCalledTimes(1);
    await expect(plugin.models.bundles.count()).resolves.toBe(2);
  });

  it("rejects conflicting writes to the same row without rerunning the callback", async () => {
    const seed = createMemoryPlugin(config());
    await insertBundleRow(seed, bundleRow("1"));
    let snapshotReads = 0;
    const externalSnapshot = {
      version: 2 as const,
      bundles: [{ ...bundleRow("1"), message: "external" }],
      bundle_patches: [],
    };
    const plugin = createMemoryPlugin({
      ...config(),
      onSnapshotRead: () => {
        snapshotReads += 1;
        if (snapshotReads === 2) {
          store.set(BLOB_DATABASE_SNAPSHOT_KEY, externalSnapshot);
        }
      },
    });
    const mutation = vi.fn(() =>
      updateBundleRow(plugin, fixtureId("1"), { message: "local" }),
    );

    await expect(mutation()).rejects.toThrow(
      "changed while a mutation was in progress",
    );

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toBe(externalSnapshot);
  });
});

const fixtureId = (suffix: string): string =>
  `00000000-0000-0000-0000-${suffix.padStart(12, "0")}`;

const channelId = (name: string): string =>
  `legacy-channel:${encodeURIComponent(name)}`;

const bundleRow = (suffix: string) => ({
  id: fixtureId(suffix),
  platform: "ios" as const,
  should_force_update: false,
  enabled: true,
  file_hash: `hash-${suffix}`,
  git_commit_hash: null,
  message: `bundle-${suffix}`,
  channel: "production",
  channel_id: channelId("production"),
  storage_uri: `storage://bundles/${suffix}.zip`,
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: {},
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

const legacyBundle = (suffix: string): Bundle => ({
  id: fixtureId(suffix),
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${suffix}`,
  gitCommitHash: null,
  message: `bundle-${suffix}`,
  channel: "production",
  storageUri: `storage://bundles/${suffix}.zip`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  metadata: {},
});
