import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";

import {
  BundleRowHydrationError,
  bundleToPatchRows,
  bundleToRow,
  rowsToBundles,
  type BundlePatchRow,
  type BundleRow,
} from "./bundleRows";

const createBundle = (id: string): Bundle => ({
  id,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  message: null,
  channel: "production",
  storageUri: `s3://bucket/${id}.zip`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
});

const toRow = (bundle: Bundle): BundleRow => bundleToRow(bundle);

const createPatchRow = (
  id: string,
  bundleId: string,
  baseBundleId: string,
  orderIndex: number,
): BundlePatchRow => ({
  id,
  bundle_id: bundleId,
  base_bundle_id: baseBundleId,
  base_file_hash: `base-hash-${id}`,
  patch_file_hash: `patch-hash-${id}`,
  patch_storage_uri: `s3://bucket/${id}.patch`,
  order_index: orderIndex,
});

describe("bundle row conversion", () => {
  it("round-trips bundle fields without embedding patch artifacts in the bundle row", () => {
    // Given
    const baseBundle = createBundle("base");
    const bundle: Bundle = {
      ...createBundle("target"),
      metadata: { app_version: "1.0.0" },
      manifestStorageUri: "s3://bucket/manifest.json",
      manifestFileHash: "manifest-hash",
      assetBaseStorageUri: "s3://bucket/assets",
      rolloutCohortCount: 250,
      targetCohorts: ["beta"],
      patches: [
        {
          baseBundleId: baseBundle.id,
          baseFileHash: "base-hash",
          patchFileHash: "patch-hash",
          patchStorageUri: "s3://bucket/target.patch",
        },
      ],
    };

    // When
    const row = toRow(bundle);
    const patchRows = bundleToPatchRows(bundle);
    const hydratedBundles = rowsToBundles([row], patchRows, [
      toRow(baseBundle),
    ]);

    // Then
    expect(row).not.toHaveProperty("patches");
    expect(row).not.toHaveProperty("patch_file_hash");
    expect(row).toMatchObject({
      channel: bundle.channel,
    });
    expect(hydratedBundles).toHaveLength(1);
    expect(hydratedBundles[0]).toEqual({
      ...bundle,
      patchBaseBundleId: baseBundle.id,
      patchBaseFileHash: "base-hash",
      patchFileHash: "patch-hash",
      patchStorageUri: "s3://bucket/target.patch",
    });
  });

  it("orders patches deterministically before deriving the compatibility scalar fields", () => {
    // Given
    const oldest = createBundle("oldest");
    const newest = createBundle("newest");
    const target = createBundle("target");
    const rows: readonly BundleRow[] = [toRow(target)];
    const later = createPatchRow("later", target.id, newest.id, 1);
    const firstById = createPatchRow("a-first", target.id, oldest.id, 0);
    const secondById = createPatchRow("z-second", target.id, newest.id, 0);

    // When
    const [hydrated] = rowsToBundles(
      rows,
      [later, secondById, firstById],
      [toRow(oldest), toRow(newest)],
    );

    // Then
    expect(hydrated?.patches?.map((patch) => patch.patchFileHash)).toEqual([
      firstById.patch_file_hash,
      secondById.patch_file_hash,
      later.patch_file_hash,
    ]);
    expect(hydrated?.patchBaseBundleId).toBe(firstById.base_bundle_id);
    expect(hydrated?.patchBaseFileHash).toBe(firstById.base_file_hash);
    expect(hydrated?.patchFileHash).toBe(firstById.patch_file_hash);
    expect(hydrated?.patchStorageUri).toBe(firstById.patch_storage_uri);
  });

  it("hydrates an empty patch set with compatibility defaults", () => {
    // Given
    const bundle = createBundle("without-patches");

    // When
    const [hydrated] = rowsToBundles([toRow(bundle)], [], []);

    // Then
    expect(hydrated).toMatchObject({
      patches: [],
      patchBaseBundleId: null,
      patchBaseFileHash: null,
      patchFileHash: null,
      patchStorageUri: null,
    });
  });

  it("normalizes malformed metadata at the row boundary", () => {
    // Given
    const row: BundleRow = {
      ...toRow(createBundle("malformed-json")),
      metadata: "not-json",
    };

    // When
    const [hydrated] = rowsToBundles([row], [], []);

    // Then
    expect(hydrated).toMatchObject({
      metadata: undefined,
      rolloutCohortCount: 1000,
      targetCohorts: null,
    });
  });

  it("rejects duplicate patch ids during aggregate hydration", () => {
    // Given
    const base = createBundle("base");
    const target = createBundle("target");
    const patch = createPatchRow("duplicate", target.id, base.id, 0);
    const duplicate = { ...patch, base_file_hash: "different-hash" };

    // When
    const hydrate = () =>
      rowsToBundles([toRow(target)], [patch, duplicate], [toRow(base)]);

    // Then
    expect(hydrate).toThrowError(BundleRowHydrationError);
    expect(hydrate).toThrowError(
      expect.objectContaining({
        reason: "duplicate_patch_id",
        patchId: patch.id,
      }),
    );
  });

  it("rejects a patch whose owner bundle row is absent", () => {
    // Given
    const base = createBundle("base");
    const patch = createPatchRow("orphan-owner", "missing", base.id, 0);

    // When
    const hydrate = () => rowsToBundles([], [patch], [toRow(base)]);

    // Then
    expect(hydrate).toThrowError(
      expect.objectContaining({
        reason: "orphan_patch_owner",
        patchId: patch.id,
        bundleId: patch.bundle_id,
      }),
    );
  });

  it("rejects a patch whose base bundle row is absent", () => {
    // Given
    const target = createBundle("target");
    const patch = createPatchRow("orphan-base", target.id, "missing", 0);

    // When
    const hydrate = () => rowsToBundles([toRow(target)], [patch], []);

    // Then
    expect(hydrate).toThrowError(
      expect.objectContaining({
        reason: "orphan_patch_base",
        patchId: patch.id,
        bundleId: patch.base_bundle_id,
      }),
    );
  });
});
