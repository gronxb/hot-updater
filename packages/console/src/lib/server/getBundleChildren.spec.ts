// @vitest-environment node

import type { Bundle, DatabasePlugin } from "@hot-updater/plugin-core";
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

function createDatabasePlugin(bundles: Bundle[]) {
  const bundleMap = new Map(bundles.map((bundle) => [bundle.id, bundle]));

  return {
    name: "mockDatabase",
    getChannels: vi.fn(),
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
    updateBundle: vi.fn(),
    appendBundle: vi.fn(),
    commitBundle: vi.fn(),
    deleteBundle: vi.fn(),
  } satisfies DatabasePlugin;
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
