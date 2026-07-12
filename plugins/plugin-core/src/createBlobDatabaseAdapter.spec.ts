import type { Bundle } from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BLOB_DATABASE_SNAPSHOT_KEY,
  createBlobDatabaseAdapter,
} from "./createBlobDatabaseAdapter";
import { createDatabaseClient } from "./databaseClient";

type MemoryConfig = {
  readonly store: Map<string, unknown>;
  readonly failNextUpload: () => boolean;
  readonly invalidations: string[][];
  readonly onSnapshotRead?: () => void;
};

const createMemoryAdapter = (
  config: MemoryConfig,
  onDatabaseUpdated?: () => Promise<void>,
) =>
  createBlobDatabaseAdapter<MemoryConfig>({
    name: "memoryBlobDatabase",
    factory: (input) => ({
      apiBasePath: "/api/check-update",
      listObjects: async (prefix) =>
        [...input.store.keys()].filter((key) => key.startsWith(prefix)),
      loadObject: async (key) => {
        if (key === BLOB_DATABASE_SNAPSHOT_KEY) input.onSnapshotRead?.();
        return input.store.get(key) ?? null;
      },
      uploadObject: async (key, data) => {
        if (input.failNextUpload()) {
          throw new Error("fixture upload failure");
        }
        input.store.set(key, data);
      },
      invalidatePaths: async (paths) => {
        input.invalidations.push([...paths]);
      },
    }),
  })(config, onDatabaseUpdated ? { onDatabaseUpdated } : undefined);

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

describe("blob snapshot persistence", () => {
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

    const adapter = createMemoryAdapter(config());
    const patches = await adapter.findMany({ model: "bundle_patches" });

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
    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toMatchObject({
      version: 2,
      channels: [{ id: "production" }],
    });
  });

  it("writes deterministic fixed-model snapshots and preserves empty channels", async () => {
    const adapter = createMemoryAdapter(config());
    await adapter.create({ model: "channels", data: { id: "unused" } });
    await adapter.create({ model: "channels", data: { id: "production" } });
    await adapter.create({ model: "bundles", data: bundleRow("2") });
    await adapter.create({ model: "bundles", data: bundleRow("1") });
    await adapter.delete({
      model: "bundles",
      where: [{ field: "channel", value: "production" }],
    });

    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toEqual({
      version: 2,
      bundles: [],
      bundle_patches: [],
      channels: [{ id: "production" }, { id: "unused" }],
    });
  });

  it("keeps the previous snapshot readable and skips hooks after a failed write", async () => {
    const onDatabaseUpdated = vi.fn(async () => undefined);
    const adapter = createMemoryAdapter(config(), onDatabaseUpdated);
    const client = createDatabaseClient(adapter);
    await client.insertBundle(legacyBundle("1"));
    const previous = store.get(BLOB_DATABASE_SNAPSHOT_KEY);
    uploadShouldFail = true;

    await expect(client.insertBundle(legacyBundle("2"))).rejects.toThrow(
      "fixture upload failure",
    );

    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toEqual(previous);
    expect(onDatabaseUpdated).toHaveBeenCalledTimes(1);
  });

  it("rejects a corrupt v2 snapshot without replacing it", async () => {
    const corrupt = {
      version: 2,
      bundles: [bundleRow("1")],
      bundle_patches: [],
      channels: [],
    };
    store.set(BLOB_DATABASE_SNAPSHOT_KEY, corrupt);
    const adapter = createMemoryAdapter(config());

    await expect(adapter.count({ model: "bundles" })).rejects.toThrow(
      "Invalid blob database data",
    );

    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toBe(corrupt);
  });

  it("invalidates exact, range, and fingerprint update routes", async () => {
    const adapter = createMemoryAdapter(config());
    await adapter.create({ model: "channels", data: { id: "production" } });
    await adapter.create({ model: "bundles", data: bundleRow("1") });
    await adapter.create({
      model: "bundles",
      data: {
        ...bundleRow("2"),
        target_app_version: ">=1.0.0 <2.0.0",
      },
    });
    await adapter.create({
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

  it("reloads the latest snapshot written by another adapter instance", async () => {
    const first = createMemoryAdapter(config());
    const second = createMemoryAdapter(config());
    await first.create({ model: "channels", data: { id: "production" } });

    await second.create({ model: "bundles", data: bundleRow("1") });

    await expect(first.count({ model: "bundles" })).resolves.toBe(1);
  });

  it("rejects a write when another adapter changes the loaded snapshot", async () => {
    let snapshotReads = 0;
    const externalSnapshot = {
      version: 2 as const,
      bundles: [],
      bundle_patches: [],
      channels: [{ id: "external" }],
    };
    const adapter = createMemoryAdapter({
      ...config(),
      onSnapshotRead: () => {
        snapshotReads += 1;
        if (snapshotReads === 2) {
          store.set(BLOB_DATABASE_SNAPSHOT_KEY, externalSnapshot);
        }
      },
    });

    await expect(
      adapter.create({ model: "channels", data: { id: "local" } }),
    ).rejects.toThrow("changed while a mutation was in progress");

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
