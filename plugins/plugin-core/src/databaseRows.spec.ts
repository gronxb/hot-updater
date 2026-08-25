import type { Bundle } from "@hot-updater/core";
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
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  storageUri: `storage://${id}`,
  archiveByteSize: 3_000_000_001,
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
          baseFileHash: firstBase.fileHash,
          byteSize: 3_000_000_002,
          patchFileHash: "patch-a",
          patchStorageUri: "storage://patch-a",
        },
        {
          baseBundleId: secondBase.id,
          baseFileHash: secondBase.fileHash,
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

  it("rejects duplicate patch ids", () => {
    const base = createBundle("base");
    const bundle: Bundle = {
      ...createBundle("target"),
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
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
      base_file_hash: base.fileHash,
      patch_file_hash: "patch",
      patch_storage_uri: "storage://patch",
      patch_byte_size: 3_000_000_002,
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
