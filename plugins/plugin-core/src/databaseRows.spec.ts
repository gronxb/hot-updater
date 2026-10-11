import type { Bundle } from "@hot-updater/protocol";
import { describe, expect, it } from "vitest";

import {
  BundleRowHydrationError,
  BundleRowHydrationErrorReason,
  bundleToPatchRows,
  bundleToRow,
  rowToBundle,
  rowsToBundles,
} from "./databaseRows";

const createBundle = (id: string): Bundle => ({
  id,
  platform: "ios",
  gitCommitHash: null,
  manifestStorageUri: `storage://${id}/manifest.json`,
  manifestFileHash: `manifest-hash-${id}`,
  assetBaseStorageUri: "storage://assets",
  metadata: { app_version: "1.0.0" },
});

describe("database rows", () => {
  const toRow = (bundle: Bundle) => bundleToRow(bundle);

  it("defaults missing metadata but rejects explicit null metadata", () => {
    const missingMetadata = createBundle("missing-metadata");
    Reflect.deleteProperty(missingMetadata, "metadata");
    const nullMetadata = createBundle("null-metadata");
    Reflect.set(nullMetadata, "metadata", null);

    expect(toRow(missingMetadata).metadata).toEqual({});
    expect(() => toRow(nullMetadata)).toThrowError(
      expect.objectContaining({ code: "invalid-data" }),
    );
  });

  it("round-trips nested JSON metadata without loss", () => {
    const metadata = {
      app_version: "1.0.0",
      release: { flags: [true, null, 3, "stable"] },
    } as const;
    const row = { ...toRow(createBundle("metadata")), metadata };

    expect(rowToBundle(row).metadata).toEqual(metadata);
  });

  it("round-trips multiple ordered patch artifacts", () => {
    const firstBase = createBundle("base-a");
    const secondBase = createBundle("base-b");
    const bundle: Bundle = {
      ...createBundle("target"),
      patches: [
        {
          baseBundleId: firstBase.id,
          baseFileHash: `asset-hash-${firstBase.id}`,
          byteSize: 3_000_000_002,
          patchFileHash: "patch-a",
          patchStorageUri: "storage://patch-a",
        },
        {
          baseBundleId: secondBase.id,
          baseFileHash: `asset-hash-${secondBase.id}`,
          byteSize: 3_000_000_003,
          patchFileHash: "patch-b",
          patchStorageUri: "storage://patch-b",
        },
      ],
    };
    const patchRows = bundleToPatchRows(bundle).toReversed();

    const [hydrated] = rowsToBundles([toRow(bundle)], patchRows, [
      toRow(firstBase),
      toRow(secondBase),
    ]);

    expect(hydrated?.patches).toEqual(bundle.patches);
    expect(toRow(bundle)).not.toHaveProperty("target_cohorts");
  });

  it("keeps patches and release fields out of the bundle row", () => {
    const base = createBundle("base");
    const bundle: Bundle = {
      ...createBundle("target"),
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: `asset-hash-${base.id}`,
          byteSize: 3_000_000_002,
          patchFileHash: "patch",
          patchStorageUri: "storage://patch",
        },
      ],
    };

    const row = toRow(bundle);
    const hydrated = rowsToBundles([row], bundleToPatchRows(bundle), [
      toRow(base),
    ]);

    expect(row).not.toHaveProperty("patches");
    expect(row).not.toHaveProperty("patch_file_hash");
    expect(row).not.toHaveProperty("channel");
    expect(row).not.toHaveProperty("enabled");
    expect(hydrated).toEqual([bundle]);
  });

  it("orders patches by their order index, then by id", () => {
    const oldest = createBundle("oldest");
    const newest = createBundle("newest");
    const target = createBundle("target");
    const patchRow = (
      id: string,
      baseBundleId: string,
      orderIndex: number,
    ) => ({
      id,
      bundle_id: target.id,
      base_bundle_id: baseBundleId,
      base_file_hash: `base-hash-${id}`,
      patch_file_hash: `patch-hash-${id}`,
      patch_storage_uri: `storage://${id}.patch`,
      byte_size: 3_000_000_002,
      order_index: orderIndex,
    });
    const later = patchRow("later", newest.id, 1);
    const firstById = patchRow("a-first", oldest.id, 0);
    const secondById = patchRow("z-second", newest.id, 0);

    const [hydrated] = rowsToBundles(
      [toRow(target)],
      [later, secondById, firstById],
      [toRow(oldest), toRow(newest)],
    );

    expect(hydrated?.patches?.map((patch) => patch.patchFileHash)).toEqual([
      firstById.patch_file_hash,
      secondById.patch_file_hash,
      later.patch_file_hash,
    ]);
  });

  it("hydrates a bundle without patch rows with an empty patch list", () => {
    const [hydrated] = rowsToBundles(
      [toRow(createBundle("without-patches"))],
      [],
      [],
    );

    expect(hydrated).toMatchObject({ patches: [] });
  });

  it("rejects duplicate patch ids", () => {
    const base = createBundle("base");
    const bundle: Bundle = {
      ...createBundle("target"),
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: `asset-hash-${base.id}`,
          byteSize: 3_000_000_002,
          patchFileHash: "patch",
          patchStorageUri: "storage://patch",
        },
      ],
    };
    const patch = bundleToPatchRows(bundle)[0];
    if (!patch) {
      throw new BundleRowHydrationError({
        reason: BundleRowHydrationErrorReason.duplicatePatchId,
        patchId: "missing-test-patch",
        bundleId: bundle.id,
      });
    }

    const hydrate = () =>
      rowsToBundles([toRow(bundle)], [patch, patch], [toRow(base)]);

    expect(hydrate).toThrowError(
      expect.objectContaining({
        reason: BundleRowHydrationErrorReason.duplicatePatchId,
      }),
    );
  });

  it("rejects orphan owners and bases", () => {
    const base = createBundle("base");
    const target = createBundle("target");
    const patch = {
      id: "target:base",
      bundle_id: target.id,
      base_bundle_id: base.id,
      base_file_hash: `asset-hash-${base.id}`,
      patch_file_hash: "patch",
      patch_storage_uri: "storage://patch",
      byte_size: 3_000_000_002,
      order_index: 0,
    } as const;

    const orphanOwner = () => rowsToBundles([], [patch], [toRow(base)]);
    const orphanBase = () => rowsToBundles([toRow(target)], [patch], []);

    expect(orphanOwner).toThrowError(
      expect.objectContaining({
        reason: BundleRowHydrationErrorReason.orphanPatchOwner,
      }),
    );
    expect(orphanBase).toThrowError(
      expect.objectContaining({
        reason: BundleRowHydrationErrorReason.orphanPatchBase,
      }),
    );
  });
});
