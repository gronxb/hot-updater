// @vitest-environment node

import type { Bundle, DatabaseClient } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { getBundleChildCounts, getBundleChildren } from "./getBundleChildren";

const createBundle = (overrides: Partial<Bundle>): Bundle => ({
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  platform: "ios",
  fileHash: "bundle-hash",
  storageUri: "s3://bucket/bundle.zip",
  archiveByteSize: 3_000_000_001,
  gitCommitHash: "deadbeef",
  ...overrides,
});

function createDatabaseClient(bundles: Bundle[]) {
  const bundleMap = new Map(bundles.map((bundle) => [bundle.id, bundle]));

  return {
    getChannels: vi.fn(),
    insertChannel: vi.fn(),
    deleteChannel: vi.fn(),
    getBundleById: vi.fn(
      async (bundleId: string) => bundleMap.get(bundleId) ?? null,
    ),
    getBundles: vi.fn(async () => ({
      data: bundles,
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: bundles.length,
        totalPages: 1,
      },
    })),
    insertBundle: vi.fn(),
    updateBundleById: vi.fn(),
    deleteBundleById: vi.fn(),
    mutate: vi.fn(),
  } satisfies DatabaseClient;
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
          byteSize: 3_000_000_002,
        },
        {
          baseBundleId: baseBundle.id,
          baseFileHash: "base-hash",
          patchFileHash: "patch-hash",
          patchStorageUri: "s3://bucket/base.patch",
          byteSize: 3_000_000_003,
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
          byteSize: 3_000_000_004,
        },
      ],
    });
    const databaseClient = createDatabaseClient([
      patchedBundle,
      unrelatedBundle,
      baseBundle,
      olderBaseBundle,
    ]);

    await expect(
      getBundleChildren({ baseBundleId: baseBundle.id }, { databaseClient }),
    ).resolves.toEqual([patchedBundle]);
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
          byteSize: 3_000_000_002,
        },
        {
          baseBundleId: olderBaseBundle.id,
          baseFileHash: "older-base-hash",
          patchFileHash: "older-patch-hash",
          patchStorageUri: "s3://bucket/older.patch",
          byteSize: 3_000_000_003,
        },
      ],
    });
    const databaseClient = createDatabaseClient([
      patchedBundle,
      baseBundle,
      olderBaseBundle,
    ]);

    await expect(
      getBundleChildCounts([baseBundle.id, olderBaseBundle.id], {
        databaseClient,
      }),
    ).resolves.toEqual({
      [baseBundle.id]: 1,
      [olderBaseBundle.id]: 1,
    });
  });
});
