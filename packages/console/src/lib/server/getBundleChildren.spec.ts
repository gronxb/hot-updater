// @vitest-environment node

import type {
  Bundle,
  BundleListQuery,
  BundlePatchListQuery,
  CursorPage,
  DatabaseBundlePatch,
  DatabaseBundleRecord,
  DatabasePluginRuntime,
} from "@hot-updater/plugin-core";
import { splitDatabaseBundle } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { getBundleChildCounts, getBundleChildren } from "./getBundleChildren";

const createBundle = (overrides: Partial<Bundle>): Bundle => ({
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "bundle-hash",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Bundle",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
  ...overrides,
});

const createCursorPage = <TData>(
  data: readonly TData[],
): CursorPage<TData> => ({
  data,
  pagination: {
    currentPage: 1,
    hasNextPage: false,
    hasPreviousPage: false,
    nextCursor: null,
    previousCursor: null,
    total: data.length,
    totalPages: data.length === 0 ? 0 : 1,
  },
});

const matchesBundleWhere = (
  bundle: DatabaseBundleRecord,
  where: BundleListQuery["where"],
) => {
  if (!where) return true;
  return (
    (where.channel === undefined || bundle.channel === where.channel) &&
    (where.platform === undefined || bundle.platform === where.platform)
  );
};

const getPatchId = (patch: DatabaseBundlePatch): string =>
  patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`;

const matchesBundlePatchWhere = (
  patch: DatabaseBundlePatch,
  where: BundlePatchListQuery["where"],
) => {
  if (!where) return true;
  return (
    (where.id === undefined || getPatchId(patch) === where.id) &&
    (where.bundleId === undefined || patch.bundleId === where.bundleId) &&
    (where.baseBundleId === undefined ||
      patch.baseBundleId === where.baseBundleId) &&
    (where.idIn === undefined || where.idIn.includes(getPatchId(patch))) &&
    (where.bundleIdIn === undefined ||
      where.bundleIdIn.includes(patch.bundleId)) &&
    (where.baseBundleIdIn === undefined ||
      where.baseBundleIdIn.includes(patch.baseBundleId))
  );
};

function createDatabasePlugin(bundles: Bundle[]) {
  const bundleRecords = new Map<string, DatabaseBundleRecord>();
  const bundlePatches: DatabaseBundlePatch[] = [];

  for (const bundle of bundles) {
    const split = splitDatabaseBundle(bundle);
    bundleRecords.set(bundle.id, split.bundle);
    bundlePatches.push(...split.patches);
  }

  return {
    name: "mockDatabase",
    bundles: {
      delete: vi.fn(),
      getById: vi.fn(
        async ({ bundleId }) => bundleRecords.get(bundleId) ?? null,
      ),
      insert: vi.fn(),
      list: vi.fn(async ({ where }) =>
        createCursorPage(
          Array.from(bundleRecords.values()).filter((bundle) =>
            matchesBundleWhere(bundle, where),
          ),
        ),
      ),
      update: vi.fn(),
    },
    bundlePatches: {
      getById: vi.fn(
        async ({ patchId }) =>
          bundlePatches.find((patch) => getPatchId(patch) === patchId) ?? null,
      ),
      list: vi.fn(async ({ where }) =>
        createCursorPage(
          bundlePatches.filter((patch) =>
            matchesBundlePatchWhere(patch, where),
          ),
        ),
      ),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    commit: vi.fn(),
  } satisfies DatabasePluginRuntime;
}

describe("getBundleChildren", () => {
  it("finds bundles that have any generated patch for the selected base", async () => {
    const baseBundle = createBundle({
      id: "0195a408-8f13-7d9b-8df4-111111111111",
    });
    const olderBaseBundle = createBundle({
      id: "0195a408-8f13-7d9b-8df4-222222222222",
    });
    const patchedBundle = createBundle({
      id: "0195a408-8f13-7d9b-8df4-333333333333",
      patches: [
        {
          baseBundleId: olderBaseBundle.id,
          baseFileHash: "older-base-hash",
          patchFileHash: "older-patch-hash",
          patchStorageUri: "s3://bucket/older.patch",
        },
        {
          baseBundleId: baseBundle.id,
          baseFileHash: "base-hash",
          patchFileHash: "patch-hash",
          patchStorageUri: "s3://bucket/base.patch",
        },
      ],
    });
    const unrelatedBundle = createBundle({
      id: "0195a408-8f13-7d9b-8df4-444444444444",
      patches: [
        {
          baseBundleId: "0195a408-8f13-7d9b-8df4-555555555555",
          baseFileHash: "other-base-hash",
          patchFileHash: "other-patch-hash",
          patchStorageUri: "s3://bucket/other.patch",
        },
      ],
    });
    const databasePlugin = createDatabasePlugin([
      patchedBundle,
      unrelatedBundle,
      baseBundle,
      olderBaseBundle,
    ]);

    await expect(
      getBundleChildren({ baseBundleId: baseBundle.id }, { databasePlugin }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: patchedBundle.id,
        patches: patchedBundle.patches,
      }),
    ]);
  });

  it("counts one patched bundle for each base it can patch from", async () => {
    const baseBundle = createBundle({
      id: "0195a408-8f13-7d9b-8df4-111111111111",
    });
    const olderBaseBundle = createBundle({
      id: "0195a408-8f13-7d9b-8df4-222222222222",
    });
    const patchedBundle = createBundle({
      id: "0195a408-8f13-7d9b-8df4-333333333333",
      patches: [
        {
          baseBundleId: baseBundle.id,
          baseFileHash: "base-hash",
          patchFileHash: "patch-hash",
          patchStorageUri: "s3://bucket/base.patch",
        },
        {
          baseBundleId: olderBaseBundle.id,
          baseFileHash: "older-base-hash",
          patchFileHash: "older-patch-hash",
          patchStorageUri: "s3://bucket/older.patch",
        },
      ],
    });
    const databasePlugin = createDatabasePlugin([
      patchedBundle,
      baseBundle,
      olderBaseBundle,
    ]);

    await expect(
      getBundleChildCounts([baseBundle.id, olderBaseBundle.id], {
        databasePlugin,
      }),
    ).resolves.toEqual({
      [baseBundle.id]: 1,
      [olderBaseBundle.id]: 1,
    });
  });
});
