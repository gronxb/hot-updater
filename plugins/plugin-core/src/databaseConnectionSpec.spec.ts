import { describe, expect, it } from "vitest";

import { standardBundlePatchTable } from "./databaseBundlePatchTable";
import {
  normalizeDatabaseDeclaration,
  type DatabasePluginDeclaration,
} from "./databaseConnectionSpec";
import type { DatabaseBundlePatch, DatabaseBundleRecord } from "./types";

const bundle: DatabaseBundleRecord = {
  id: "bundle-1",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "hash",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: null,
  message: null,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: null,
  targetCohorts: null,
};

const patch = (
  bundleId: string,
  baseBundleId: string,
  orderIndex: number,
): DatabaseBundlePatch => ({
  bundleId,
  baseBundleId,
  baseFileHash: `base-${baseBundleId}`,
  patchFileHash: `patch-${bundleId}-${baseBundleId}`,
  patchStorageUri: `s3://bucket/${bundleId}-${baseBundleId}.patch`,
  orderIndex,
});

const bundles = {
  getById: async () => bundle,
  findRecords: async () => [bundle],
  insert: async () => undefined,
  update: async () => undefined,
  delete: async () => undefined,
};

describe("database connection spec", () => {
  it("normalizes row-backed SQL or NoSQL patch storage from one declarative field", async () => {
    let rows = [standardBundlePatchTable.toRow(patch("bundle-1", "base-1", 0))];
    const connection: DatabasePluginDeclaration = {
      bundles,
      patches: {
        storage: "rows",
        findRows: () => rows,
        getRowById: ({ patchId }) =>
          rows.find((row) => row.id === patchId) ?? null,
        insertRow({ row }) {
          rows = rows.filter((current) => current.id !== row.id).concat(row);
        },
        updateRow({ patchId, row }) {
          rows = rows.map((current) =>
            current.id === patchId ? { ...current, ...row } : current,
          );
        },
        deleteRow({ patchId }) {
          rows = rows.filter((row) => row.id !== patchId);
        },
      },
    };

    const core = normalizeDatabaseDeclaration(connection);

    await core.bundlePatches.insert({
      patch: patch("bundle-1", "base-2", 1),
    });
    await core.bundlePatches.update({
      patchId: "bundle-1:base-2",
      patch: { patchStorageUri: "s3://bucket/updated.patch" },
    });
    await core.bundlePatches.delete({ patchId: "bundle-1:base-1" });

    await expect(
      core.bundlePatches.findMany({
        where: { bundleId: "bundle-1" },
        window: { offset: 0, limit: 10 },
      }),
    ).resolves.toStrictEqual([
      {
        ...patch("bundle-1", "base-2", 1),
        id: "bundle-1:base-2",
        patchStorageUri: "s3://bucket/updated.patch",
      },
    ]);
  });

  it("normalizes embedded bundle-document patch storage from the same declarative field", async () => {
    const patchesByBundle = new Map<string, readonly DatabaseBundlePatch[]>([
      ["bundle-1", [patch("bundle-1", "base-1", 0)]],
    ]);
    const connection: DatabasePluginDeclaration = {
      bundles,
      patches: {
        storage: "embedded",
        findPatches: () => Array.from(patchesByBundle.values()).flat(),
        getBundlePatches: ({ bundleId }) =>
          patchesByBundle.get(bundleId) ?? null,
        replaceBundlePatches({ bundleId, patches }) {
          patchesByBundle.set(bundleId, patches);
        },
      },
    };

    const core = normalizeDatabaseDeclaration(connection);

    await core.bundlePatches.insert({
      patch: patch("bundle-1", "base-2", 2),
    });
    await core.bundlePatches.update({
      patchId: "bundle-1:base-2",
      patch: { orderIndex: 1 },
    });
    await core.bundlePatches.delete({ patchId: "bundle-1:base-1" });

    await expect(
      core.bundlePatches.findMany({
        where: { bundleId: "bundle-1" },
        window: { offset: 0, limit: 10 },
      }),
    ).resolves.toStrictEqual([
      {
        ...patch("bundle-1", "base-2", 2),
        id: "bundle-1:base-2",
        orderIndex: 1,
      },
    ]);
  });

  it("normalizes transaction declarations into core transactions", async () => {
    const patches = {
      storage: "embedded" as const,
      findPatches: async () => [],
      getBundlePatches: async () => [],
      replaceBundlePatches: async () => undefined,
    };

    const core = normalizeDatabaseDeclaration({
      bundles,
      patches,
      beginTransaction: async () => ({
        connection: {
          bundles,
          patches,
        },
        commit: async () => undefined,
        rollback: async () => undefined,
      }),
    });

    const transaction = await core.beginTransaction?.();

    await expect(
      transaction?.core.bundles.findMany({
        window: { offset: 0, limit: 10 },
      }),
    ).resolves.toEqual([bundle]);
  });
});
