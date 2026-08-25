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
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  storageUri: `s3://bucket/${id}.zip`,
  archiveByteSize: 3_000_000_001,
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
  patch_byte_size: 3_000_000_002,
  order_index: orderIndex,
});

describe("bundle row conversion", () => {
  it("round-trips bundle fields without embedding patch artifacts in the bundle row", () => {
    const baseBundle = createBundle("base");
    const bundle: Bundle = {
      ...createBundle("target"),
      metadata: { app_version: "1.0.0" },
      manifestStorageUri: "s3://bucket/manifest.json",
      manifestFileHash: "manifest-hash",
      assetBaseStorageUri: "s3://bucket/assets",
      patches: [
        {
          baseBundleId: baseBundle.id,
          baseFileHash: "base-hash",
          byteSize: 3_000_000_002,
          patchFileHash: "patch-hash",
          patchStorageUri: "s3://bucket/target.patch",
        },
      ],
    };

    const row = toRow(bundle);
    const patchRows = bundleToPatchRows(bundle);
    const hydratedBundles = rowsToBundles([row], patchRows, [
      toRow(baseBundle),
    ]);

    expect(row).not.toHaveProperty("patches");
    expect(row).not.toHaveProperty("patch_file_hash");
    expect(row).not.toHaveProperty("channel");
    expect(row).not.toHaveProperty("enabled");
    expect(hydratedBundles).toHaveLength(1);
    expect(hydratedBundles[0]).toEqual(bundle);
  });

  it("orders multiple patches deterministically", () => {
    const oldest = createBundle("oldest");
    const newest = createBundle("newest");
    const target = createBundle("target");
    const rows: readonly BundleRow[] = [toRow(target)];
    const later = createPatchRow("later", target.id, newest.id, 1);
    const firstById = createPatchRow("a-first", target.id, oldest.id, 0);
    const secondById = createPatchRow("z-second", target.id, newest.id, 0);

    const [hydrated] = rowsToBundles(
      rows,
      [later, secondById, firstById],
      [toRow(oldest), toRow(newest)],
    );

    expect(hydrated?.patches?.map((patch) => patch.patchFileHash)).toEqual([
      firstById.patch_file_hash,
      secondById.patch_file_hash,
      later.patch_file_hash,
    ]);
  });

  it("hydrates an empty patch set", () => {
    const bundle = createBundle("without-patches");

    const [hydrated] = rowsToBundles([toRow(bundle)], [], []);

    expect(hydrated).toMatchObject({ patches: [] });
  });

  it("preserves nested metadata at the row boundary", () => {
    const row: BundleRow = {
      ...toRow(createBundle("nested-metadata")),
      metadata: { release: { flags: [true, null, 3] } },
    };

    const [hydrated] = rowsToBundles([row], [], []);

    expect(hydrated).toMatchObject({
      metadata: { release: { flags: [true, null, 3] } },
    });
  });

  it("rejects duplicate patch ids during aggregate hydration", () => {
    const base = createBundle("base");
    const target = createBundle("target");
    const patch = createPatchRow("duplicate", target.id, base.id, 0);
    const duplicate = { ...patch, base_file_hash: "different-hash" };

    const hydrate = () =>
      rowsToBundles([toRow(target)], [patch, duplicate], [toRow(base)]);

    expect(hydrate).toThrowError(BundleRowHydrationError);
    expect(hydrate).toThrowError(
      expect.objectContaining({
        reason: "duplicate_patch_id",
        patchId: patch.id,
      }),
    );
  });

  it("rejects a patch whose owner bundle row is absent", () => {
    const base = createBundle("base");
    const patch = createPatchRow("orphan-owner", "missing", base.id, 0);

    const hydrate = () => rowsToBundles([], [patch], [toRow(base)]);

    expect(hydrate).toThrowError(
      expect.objectContaining({
        reason: "orphan_patch_owner",
        patchId: patch.id,
        bundleId: patch.bundle_id,
      }),
    );
  });

  it("rejects a patch whose base bundle row is absent", () => {
    const target = createBundle("target");
    const patch = createPatchRow("orphan-base", target.id, "missing", 0);

    const hydrate = () => rowsToBundles([toRow(target)], [patch], []);

    expect(hydrate).toThrowError(
      expect.objectContaining({
        reason: "orphan_patch_base",
        patchId: patch.id,
        bundleId: patch.base_bundle_id,
      }),
    );
  });
});
