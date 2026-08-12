import type { Bundle } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";

import { BlobDatabaseUnknownFieldsError } from "./blobDatabaseErrors";
import { parseLegacyBundle } from "./blobDatabaseLegacy";
import {
  blobDatabaseRevisionSnapshotKey,
  parseBlobDatabasePointer,
} from "./blobDatabaseRevision";
import { parseBlobDatabaseSnapshot } from "./blobDatabaseSnapshot";
import {
  BLOB_DATABASE_SNAPSHOT_KEY,
  createBlobDatabasePlugin,
} from "./createBlobDatabasePlugin";
import { createDatabaseClient } from "./databaseClient";
import type { BundleRow, DatabasePlugin } from "./types";

const bundleId = "00000000-0000-0000-0000-000000000001";
const channelId = (name: string): string =>
  `legacy-channel:${encodeURIComponent(name)}`;
const commonBundleRow = {
  id: bundleId,
  platform: "ios" as const,
  should_force_update: false,
  enabled: true,
  file_hash: "hash-1",
  git_commit_hash: null,
  message: "bundle-1",
  channel_id: channelId("production"),
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
const commonStoredBundleRow = {
  ...commonBundleRow,
  channel: "production",
};
const commonLegacyBundle = {
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
};

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

const createMemoryBlobDatabase = (entries: readonly [string, unknown][]) => {
  const store = new Map(entries);
  const uploadObject = vi.fn(
    async (key: string, value: unknown) => void store.set(key, value),
  );
  const compareAndSwapObject = vi.fn(
    async (key: string, expected: unknown, value: unknown) => {
      if (JSON.stringify(store.get(key) ?? null) !== JSON.stringify(expected)) {
        return false;
      }
      store.set(key, value);
      return true;
    },
  );
  const plugin = createBlobDatabasePlugin({
    name: "compatibility-memory",
    plugin: () => ({
      apiBasePath: "/api/check-update",
      listObjects: async (prefix) =>
        [...store.keys()].filter((key) => key.startsWith(prefix)),
      loadObject: async (key) => store.get(key) ?? null,
      uploadObject,
      compareAndSwapObject,
      invalidatePaths: async () => undefined,
    }),
  });
  return { compareAndSwapObject, plugin, store, uploadObject };
};

describe("blob snapshot compatibility", () => {
  it("defaults missing legacy metadata but rejects explicit null", () => {
    expect(
      parseLegacyBundle(commonLegacyBundle, "legacy").bundle.metadata,
    ).toEqual({});
    expect(() =>
      parseLegacyBundle({ ...commonLegacyBundle, metadata: null }, "legacy"),
    ).toThrow("Invalid blob database data");
  });

  it("parses documented nested legacy patches", () => {
    expect(
      parseLegacyBundle(
        {
          ...commonLegacyBundle,
          patches: [
            {
              baseBundleId: bundleId,
              baseFileHash: "base-hash",
              patchFileHash: "patch-hash",
              patchStorageUri: "storage://patches/1.patch",
            },
          ],
        },
        "legacy",
      ).patches,
    ).toEqual([
      {
        id: `${bundleId}:${bundleId}`,
        bundle_id: bundleId,
        base_bundle_id: bundleId,
        base_file_hash: "base-hash",
        patch_file_hash: "patch-hash",
        patch_storage_uri: "storage://patches/1.patch",
        order_index: 0,
      },
    ]);
  });

  it.each([
    ["unknown top-level field", { future_option: true }],
    [
      "unknown nested patch field",
      {
        patches: [
          {
            baseBundleId: bundleId,
            baseFileHash: "base-hash",
            patchFileHash: "patch-hash",
            patchStorageUri: "storage://patches/1.patch",
            future_option: true,
          },
        ],
      },
    ],
    ["malformed nested patch", { patches: [{}] }],
    ["malformed non-array patches", { patches: "invalid" }],
  ] as const)(
    "rejects a legacy manifest with a %s before publishing a v2 pointer",
    async (_case, legacyExtension) => {
      const original: readonly [string, unknown][] = [
        [
          "production/ios/1.0.0/update.json",
          [{ ...commonLegacyBundle, ...legacyExtension }],
        ],
      ];

      for (const operation of ["read", "mutation"] as const) {
        const { compareAndSwapObject, plugin, store, uploadObject } =
          createMemoryBlobDatabase(original);
        const originalEntries = structuredClone([...store.entries()]);

        const result =
          operation === "read"
            ? createDatabaseClient(plugin).getBundleById(bundleId)
            : insertBundleRow(plugin, {
                ...commonBundleRow,
                id: "00000000-0000-0000-0000-000000000002",
                channel: "production",
              });

        await expect(result).rejects.toMatchObject({
          name: "BlobDatabaseSnapshotError",
        });
        expect([...store.entries()]).toEqual(originalEntries);
        expect(store.has(BLOB_DATABASE_SNAPSHOT_KEY)).toBe(false);
        expect(uploadObject).not.toHaveBeenCalled();
        expect(compareAndSwapObject).not.toHaveBeenCalled();
      }
    },
  );

  const sparseArray: unknown[] = [];
  sparseArray.length = 1;
  it.each([
    [
      "custom prototype",
      Object.assign(Object.create({ version: 2 }), {
        bundles: [],
        bundle_patches: [],
      }),
    ],
    [
      "accessor property",
      Object.defineProperty({ version: 2, bundle_patches: [] }, "bundles", {
        enumerable: true,
        get: () => [],
      }),
    ],
    [
      "__proto__ property",
      JSON.parse(
        '{"version":2,"bundles":[],"bundle_patches":[],"__proto__":{}}',
      ),
    ],
    [
      "non-enumerable property",
      Object.defineProperty(
        { version: 2, bundles: [], bundle_patches: [] },
        "future_metadata",
        { enumerable: false, value: true },
      ),
    ],
    [
      "symbol property",
      Object.assign(
        { version: 2, bundles: [], bundle_patches: [] },
        { [Symbol("future_metadata")]: true },
      ),
    ],
  ])("rejects a snapshot with a crafted %s", (_case, value) => {
    expect(() => parseBlobDatabaseSnapshot(value)).toThrow(
      "Invalid blob database data",
    );
  });

  it.each([
    ["custom prototype", Object.setPrototypeOf([commonStoredBundleRow], null)],
    [
      "non-enumerable element",
      Object.defineProperty([commonStoredBundleRow], "0", {
        enumerable: false,
        value: commonStoredBundleRow,
      }),
    ],
    [
      "symbol property",
      Object.assign([commonStoredBundleRow], { [Symbol("future")]: true }),
    ],
    [
      "extra property",
      Object.assign([commonStoredBundleRow], { future: true }),
    ],
    ["sparse element", sparseArray],
  ])("rejects a bundles array with a crafted %s", (_case, bundles) => {
    expect(() =>
      parseBlobDatabaseSnapshot({ version: 2, bundles, bundle_patches: [] }),
    ).toThrow("Invalid blob database data");
  });

  it("rejects an accessor array element without executing it", () => {
    const read = vi.fn(() => commonStoredBundleRow);
    const bundles: unknown[] = [];
    Object.defineProperty(bundles, "0", {
      enumerable: true,
      get: read,
    });

    expect(() =>
      parseBlobDatabaseSnapshot({ version: 2, bundles, bundle_patches: [] }),
    ).toThrow("Invalid blob database data");
    expect(read).not.toHaveBeenCalled();
  });

  const cyclicMetadata: Record<string, unknown> = {};
  cyclicMetadata["self"] = cyclicMetadata;
  it.each([
    ["custom prototype", Object.assign(Object.create({ future: true }), {})],
    [
      "accessor property",
      Object.defineProperty({}, "value", {
        enumerable: true,
        get: () => true,
      }),
    ],
    [
      "non-enumerable property",
      Object.defineProperty({}, "value", { enumerable: false, value: true }),
    ],
    ["symbol property", { [Symbol("future")]: true }],
    ["sparse array", sparseArray],
    ["cycle", cyclicMetadata],
    ["toJSON method", { toJSON: () => ({ rewritten: true }) }],
  ])("rejects metadata with a crafted %s", (_case, metadata) => {
    expect(() =>
      parseBlobDatabaseSnapshot({
        version: 2,
        bundles: [{ ...commonBundleRow, channel: "production", metadata }],
        bundle_patches: [],
      }),
    ).toThrow("Invalid blob database data");
  });

  it("rejects crafted metadata before serializing a mutation", async () => {
    const toJSON = vi.fn(() => ({ rewritten: true }));
    const { compareAndSwapObject, plugin, uploadObject } =
      createMemoryBlobDatabase([]);
    const data = {
      ...commonBundleRow,
      channel: "production",
      metadata: {},
    };
    Reflect.set(data, "metadata", { toJSON });

    await expect(insertBundleRow(plugin, data)).rejects.toMatchObject({
      code: "invalid-data",
    });
    expect(toJSON).not.toHaveBeenCalled();
    expect(uploadObject).not.toHaveBeenCalled();
    expect(compareAndSwapObject).not.toHaveBeenCalled();
  });

  it("parses a snapshot with a null prototype", () => {
    const snapshot = Object.assign(Object.create(null), {
      version: 2,
      bundles: [],
      bundle_patches: [],
    });

    expect(parseBlobDatabaseSnapshot(snapshot)).toEqual({
      version: 2,
      bundles: [],
      bundle_patches: [],
      channels: [],
      bundle_events: [],
      client_access_keys: [],
    });
  });

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

  it("backfills channels and channel_id from a legacy v2 snapshot", () => {
    const { channel_id: _channelId, ...legacyBundleRow } =
      commonStoredBundleRow;
    const snapshot = parseBlobDatabaseSnapshot({
      version: 2,
      bundles: [legacyBundleRow],
      bundle_patches: [],
    });

    expect(snapshot.channels).toEqual([
      { id: channelId("production"), name: "production" },
    ]);
    expect(snapshot.bundles[0]).toMatchObject({
      channel: "production",
      channel_id: channelId("production"),
    });
  });

  it("reads and rewrites the direct-channel v2 shape", async () => {
    const { channel_id: _channelId, ...legacyBundleRow } =
      commonStoredBundleRow;
    const { plugin, store } = createMemoryBlobDatabase([
      [
        BLOB_DATABASE_SNAPSHOT_KEY,
        {
          version: 2,
          bundles: [legacyBundleRow],
          bundle_patches: [],
        },
      ],
    ]);

    const bundle = await createDatabaseClient(plugin).getBundleById(bundleId);
    await insertBundleRow(plugin, {
      ...commonBundleRow,
      id: `${bundleId}-staging`,
      channel: "staging",
      channel_id: channelId("staging"),
    });

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
          channel_id: channelId("staging"),
        },
      ],
      bundle_patches: [],
      channels: [
        { id: channelId("production"), name: "production" },
        { id: channelId("staging"), name: "staging" },
      ],
      bundle_events: [],
      client_access_keys: [],
    });
  });

  it("refuses to rewrite snapshots with unknown top-level fields", async () => {
    const original = {
      version: 2,
      bundles: [{ ...commonBundleRow, channel: "production" }],
      bundle_patches: [],
      legacy_extension: { records: ["preserve-me"] },
    };
    const { compareAndSwapObject, plugin, store, uploadObject } =
      createMemoryBlobDatabase([[BLOB_DATABASE_SNAPSHOT_KEY, original]]);
    const originalEntries = structuredClone([...store.entries()]);

    await expect(
      insertBundleRow(plugin, {
        ...commonBundleRow,
        id: `${bundleId}-staging`,
        channel: "staging",
        channel_id: channelId("staging"),
      }),
    ).rejects.toThrow(
      "Blob database snapshot has unknown top-level fields: legacy_extension",
    );
    expect([...store.entries()]).toEqual(originalEntries);
    expect(uploadObject).not.toHaveBeenCalled();
    expect(compareAndSwapObject).not.toHaveBeenCalled();
  });

  it("refuses to read snapshots with unknown top-level fields", async () => {
    const original = {
      version: 2,
      bundles: [{ ...commonBundleRow, channel: "production" }],
      bundle_patches: [],
      future_metadata: { preserve: true },
    };
    const { compareAndSwapObject, plugin, store, uploadObject } =
      createMemoryBlobDatabase([[BLOB_DATABASE_SNAPSHOT_KEY, original]]);
    const originalEntries = structuredClone([...store.entries()]);

    const result = createDatabaseClient(plugin).getBundleById(bundleId);

    await expect(result).rejects.toMatchObject({
      fields: ["future_metadata"],
      name: BlobDatabaseUnknownFieldsError.name,
    });
    expect([...store.entries()]).toEqual(originalEntries);
    expect(uploadObject).not.toHaveBeenCalled();
    expect(compareAndSwapObject).not.toHaveBeenCalled();
  });

  it.each([
    ["bundle", "bundles[0].future_option"],
    ["patch", "bundle_patches[0].future_option"],
  ] as const)("refuses to read unknown %s row fields", async (row, field) => {
    const targetBundleId = `${bundleId}-target`;
    const original = {
      version: 2,
      bundles: [
        {
          ...commonBundleRow,
          channel: "production",
          ...(row === "bundle" ? { future_option: { preserve: true } } : {}),
        },
        {
          ...commonBundleRow,
          id: targetBundleId,
          channel: "production",
        },
      ],
      bundle_patches: [
        {
          id: "patch-1",
          bundle_id: targetBundleId,
          base_bundle_id: bundleId,
          base_file_hash: "base-hash",
          patch_file_hash: "patch-hash",
          patch_storage_uri: "storage://patches/1.patch",
          order_index: 0,
          ...(row === "patch" ? { future_option: { preserve: true } } : {}),
        },
      ],
    };
    const { compareAndSwapObject, plugin, store, uploadObject } =
      createMemoryBlobDatabase([[BLOB_DATABASE_SNAPSHOT_KEY, original]]);
    const originalEntries = structuredClone([...store.entries()]);

    const result = createDatabaseClient(plugin).getBundleById(bundleId);

    await expect(result).rejects.toMatchObject({
      fields: [field],
      name: BlobDatabaseUnknownFieldsError.name,
    });
    expect([...store.entries()]).toEqual(originalEntries);
    expect(uploadObject).not.toHaveBeenCalled();
    expect(compareAndSwapObject).not.toHaveBeenCalled();
  });

  it("refuses to read revision pointers with unknown fields", async () => {
    const revision = "01976b57-48d2-7e1b-8ee0-9cbf4b3f0001";
    const pointer = {
      version: 2,
      active_revision: revision,
      future_metadata: { preserve: true },
    };
    const { compareAndSwapObject, plugin, store, uploadObject } =
      createMemoryBlobDatabase([
        [BLOB_DATABASE_SNAPSHOT_KEY, pointer],
        [
          blobDatabaseRevisionSnapshotKey(revision),
          {
            version: 2,
            bundles: [{ ...commonBundleRow, channel: "production" }],
            bundle_patches: [],
          },
        ],
      ]);
    const originalEntries = structuredClone([...store.entries()]);

    const result = createDatabaseClient(plugin).getBundleById(bundleId);

    await expect(result).rejects.toMatchObject({
      fields: ["future_metadata"],
      name: BlobDatabaseUnknownFieldsError.name,
    });
    expect([...store.entries()]).toEqual(originalEntries);
    expect(uploadObject).not.toHaveBeenCalled();
    expect(compareAndSwapObject).not.toHaveBeenCalled();
  });

  it("refuses to rewrite snapshots with unknown bundle row fields", async () => {
    const original = {
      version: 2,
      bundles: [
        {
          ...commonBundleRow,
          channel: "production",
          future_option: { preserve: true },
        },
      ],
      bundle_patches: [],
    };
    const { compareAndSwapObject, plugin, store, uploadObject } =
      createMemoryBlobDatabase([[BLOB_DATABASE_SNAPSHOT_KEY, original]]);
    const originalEntries = structuredClone([...store.entries()]);

    await expect(
      plugin.commit({
        changes: [
          {
            model: "bundles",
            operation: "update",
            where: { id: bundleId },
            update: { message: "updated" },
          },
        ],
      }),
    ).rejects.toThrow("bundles[0].future_option");
    expect([...store.entries()]).toEqual(originalEntries);
    expect(uploadObject).not.toHaveBeenCalled();
    expect(compareAndSwapObject).not.toHaveBeenCalled();
  });

  it("refuses to rewrite snapshots with unknown patch row fields", async () => {
    const targetBundleId = `${bundleId}-target`;
    const original = {
      version: 2,
      bundles: [
        { ...commonBundleRow, channel: "production" },
        {
          ...commonBundleRow,
          id: targetBundleId,
          channel: "production",
        },
      ],
      bundle_patches: [
        {
          id: "patch-1",
          bundle_id: targetBundleId,
          base_bundle_id: bundleId,
          base_file_hash: "base-hash",
          patch_file_hash: "patch-hash",
          patch_storage_uri: "storage://patches/1.patch",
          order_index: 0,
          future_option: { preserve: true },
        },
      ],
    };
    const { compareAndSwapObject, plugin, store, uploadObject } =
      createMemoryBlobDatabase([[BLOB_DATABASE_SNAPSHOT_KEY, original]]);
    const originalEntries = structuredClone([...store.entries()]);

    await expect(
      plugin.commit({
        changes: [
          {
            model: "bundlePatches",
            operation: "delete",
            where: { bundleId: targetBundleId },
          },
        ],
      }),
    ).rejects.toThrow("bundle_patches[0].future_option");
    expect([...store.entries()]).toEqual(originalEntries);
    expect(uploadObject).not.toHaveBeenCalled();
    expect(compareAndSwapObject).not.toHaveBeenCalled();
  });

  it("refuses to rewrite revision pointers with unknown fields", async () => {
    const revision = "01976b57-48d2-7e1b-8ee0-9cbf4b3f0001";
    const pointer = {
      version: 2,
      active_revision: revision,
      legacy_extension: { records: ["preserve-me"] },
    };
    const { compareAndSwapObject, plugin, store, uploadObject } =
      createMemoryBlobDatabase([
        [BLOB_DATABASE_SNAPSHOT_KEY, pointer],
        [
          blobDatabaseRevisionSnapshotKey(revision),
          { version: 2, bundles: [], bundle_patches: [] },
        ],
      ]);
    const originalEntries = structuredClone([...store.entries()]);

    await expect(
      insertBundleRow(plugin, { ...commonBundleRow, channel: "production" }),
    ).rejects.toThrow(
      "Blob database revision pointer has unknown top-level fields: legacy_extension",
    );
    expect([...store.entries()]).toEqual(originalEntries);
    expect(uploadObject).not.toHaveBeenCalled();
    expect(compareAndSwapObject).not.toHaveBeenCalled();
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
    const plugin = createBlobDatabasePlugin({
      name: "legacy-manifest-memory",
      plugin: () => ({
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
      plugin.queries.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        platform: "ios",
      }),
    ).resolves.toMatchObject({ id: bundleId, status: "UPDATE" });
  });
});
