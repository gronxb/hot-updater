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
import { databaseAnalyticsSupport } from "./types";

type MemoryConfig = {
  readonly store: Map<string, unknown>;
  readonly failNextUpload: () => boolean;
  readonly invalidations: string[][];
  readonly invalidatePaths?: (paths: readonly string[]) => Promise<void>;
  readonly onInvalidationError?: (failure: BlobInvalidationFailure) => void;
  readonly onLoadObject?: (key: string) => void;
  readonly onSnapshotRead?: () => void;
};

const createMemoryPlugin = (
  config: MemoryConfig,
  onDatabaseUpdated?: () => Promise<void>,
) =>
  createBlobDatabasePlugin({
    name: "memoryBlobDatabase",
    onDatabaseUpdated,
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
  it("does not advertise Analytics support", () => {
    // Given / When
    const plugin = createMemoryPlugin(config());

    // Then
    expect(plugin[databaseAnalyticsSupport]).toBeUndefined();
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
    const patches = await plugin.findMany({ model: "bundle_patches" });

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

  it("writes deterministic fixed-model snapshots", async () => {
    const plugin = createMemoryPlugin(config());
    await plugin.create({ model: "bundles", data: bundleRow("2") });
    await plugin.create({ model: "bundles", data: bundleRow("1") });
    await plugin.delete({
      model: "bundles",
      where: [{ field: "channel", value: "production" }],
    });

    expect(activeSnapshot()).toEqual({
      version: 2,
      bundles: [],
      bundle_patches: [],
      bundle_events: [],
    });
  });

  it("keeps the previous snapshot readable and skips hooks after a failed write", async () => {
    const onDatabaseUpdated = vi.fn(async () => undefined);
    const plugin = createMemoryPlugin(config(), onDatabaseUpdated);
    const client = createDatabaseClient(plugin);
    await client.insertBundle(legacyBundle("1"));
    const previous = store.get(BLOB_DATABASE_SNAPSHOT_KEY);
    uploadShouldFail = true;

    await expect(client.insertBundle(legacyBundle("2"))).rejects.toThrow(
      "fixture upload failure",
    );

    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toEqual(previous);
    expect(onDatabaseUpdated).toHaveBeenCalledTimes(1);
  });

  it("commits and reports once when bounded invalidation retries fail", async () => {
    // Given
    const invalidationError = new Error("fixture invalidation failure");
    const invalidatePaths = vi.fn(async () => {
      throw invalidationError;
    });
    const onInvalidationError = vi.fn();
    const onDatabaseUpdated = vi.fn(async () => undefined);
    const plugin = createMemoryPlugin(
      {
        ...config(),
        invalidatePaths,
        onInvalidationError,
      },
      onDatabaseUpdated,
    );
    const client = createDatabaseClient(plugin);

    // When
    await expect(
      client.insertBundle(legacyBundle("1")),
    ).resolves.toBeUndefined();

    // Then
    const reader = createMemoryPlugin(config());
    await expect(
      reader.findOne({
        model: "bundles",
        where: [{ field: "id", value: fixtureId("1") }],
      }),
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
    expect(onDatabaseUpdated).toHaveBeenCalledTimes(1);
  });

  it("rejects a corrupt v2 snapshot without replacing it", async () => {
    const corrupt = {
      version: 2,
      bundles: [{ ...bundleRow("1"), channel: undefined }],
      bundle_patches: [],
    };
    store.set(BLOB_DATABASE_SNAPSHOT_KEY, corrupt);
    const plugin = createMemoryPlugin(config());

    await expect(plugin.count({ model: "bundles" })).rejects.toThrow(
      "Invalid blob database data",
    );

    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toBe(corrupt);
  });

  it("invalidates exact, range, and fingerprint update routes", async () => {
    const plugin = createMemoryPlugin(config());
    await plugin.create({ model: "bundles", data: bundleRow("1") });
    await plugin.create({
      model: "bundles",
      data: {
        ...bundleRow("2"),
        target_app_version: ">=1.0.0 <2.0.0",
      },
    });
    await plugin.create({
      model: "bundles",
      data: {
        ...bundleRow("3"),
        target_app_version: null,
        fingerprint_hash: "fingerprint-3",
      },
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

  it("serves app-version update checks from the active revision", async () => {
    const snapshotRead = vi.fn();
    const plugin = createMemoryPlugin({
      ...config(),
      onSnapshotRead: snapshotRead,
    });
    await createDatabaseClient(plugin).insertBundle(legacyBundle("1"));
    snapshotRead.mockClear();

    await expect(
      plugin.getUpdateInfo?.({
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
    expect(activeManifest("production/ios/target-app-versions.json")).toEqual([
      "1.0.0",
    ]);
    expect(activeManifest("production/ios/1.0.0/update.json")).toEqual([
      expect.objectContaining({
        channel: "production",
        id: fixtureId("1"),
      }),
    ]);
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
      plugin.getUpdateInfo?.({
        _updateStrategy: "fingerprint",
        bundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        fingerprintHash: "fingerprint-2",
        platform: "ios",
      }),
    ).resolves.toMatchObject({ id: bundle.id, status: "UPDATE" });
    expect(snapshotRead).toHaveBeenCalledTimes(1);
    expect(activeManifest("production/ios/fingerprint-2/update.json")).toEqual([
      expect.objectContaining({ id: bundle.id }),
    ]);
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
          `${blobDatabaseRevisionManifestPrefix(firstRevision)}/production/ios/target-app-versions.json`
        ) {
          store.set(BLOB_DATABASE_SNAPSHOT_KEY, secondPointer);
        }
      },
    });

    await expect(
      reader.getUpdateInfo?.({
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
    await first.count({ model: "bundles" });

    await second.create({ model: "bundles", data: bundleRow("1") });

    await expect(first.count({ model: "bundles" })).resolves.toBe(1);
  });

  it("preserves concurrent writes across plugin instances", async () => {
    const plugins = Array.from({ length: 5 }, () =>
      createMemoryPlugin(config()),
    );

    await Promise.all(
      plugins.map((plugin, index) =>
        plugin.create({
          model: "bundles",
          data: bundleRow(String(index + 1)),
        }),
      ),
    );

    const reader = plugins[0];
    if (!reader) throw new Error("Expected a concurrent plugin fixture.");
    await expect(reader.count({ model: "bundles" })).resolves.toBe(5);
  });

  it("merges a disjoint concurrent write without rerunning the callback", async () => {
    let snapshotReads = 0;
    const externalSnapshot = {
      version: 2 as const,
      bundles: [bundleRow("2")],
      bundle_patches: [],
      bundle_events: [],
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
    const mutation = vi.fn(async (database) => {
      await database.create({
        model: "bundles",
        data: bundleRow("1"),
      });
      return "created";
    });
    if (!plugin.transaction) {
      throw new Error("Expected a transactional blob plugin fixture.");
    }

    await expect(plugin.transaction(mutation)).resolves.toBe("created");

    expect(mutation).toHaveBeenCalledTimes(1);
    await expect(plugin.count({ model: "bundles" })).resolves.toBe(2);
  });

  it("rejects conflicting writes to the same row without rerunning the callback", async () => {
    const seed = createMemoryPlugin(config());
    await seed.create({ model: "bundles", data: bundleRow("1") });
    let snapshotReads = 0;
    const externalSnapshot = {
      version: 2 as const,
      bundles: [{ ...bundleRow("1"), message: "external" }],
      bundle_patches: [],
      bundle_events: [],
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
    const mutation = vi.fn(async (database) => {
      await database.update({
        model: "bundles",
        where: [{ field: "id", value: fixtureId("1") }],
        update: { message: "local" },
      });
    });
    if (!plugin.transaction) {
      throw new Error("Expected a transactional blob plugin fixture.");
    }

    await expect(plugin.transaction(mutation)).rejects.toThrow(
      "changed while a mutation was in progress",
    );

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toBe(externalSnapshot);
  });
});

const fixtureId = (suffix: string): string =>
  `00000000-0000-0000-0000-${suffix.padStart(12, "0")}`;

const bundleRow = (suffix: string) => ({
  id: fixtureId(suffix),
  platform: "ios" as const,
  should_force_update: false,
  enabled: true,
  file_hash: `hash-${suffix}`,
  git_commit_hash: null,
  message: `bundle-${suffix}`,
  channel: "production",
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
