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
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  message: null,
  channel: "production",
  storageUri: `storage://${id}`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  metadata: { app_version: "1.0.0" },
  rolloutCohortCount: 250,
  targetCohorts: ["qa"],
});

describe("database rows", () => {
  const toRow = (bundle: Bundle) => bundleToRow(bundle, "channel-production");

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

  it("round-trips ordered patches and derives the scalar compatibility view", () => {
    const firstBase = createBundle("base-a");
    const secondBase = createBundle("base-b");
    const bundle: Bundle = {
      ...createBundle("target"),
      patches: [
        {
          baseBundleId: firstBase.id,
          baseFileHash: firstBase.fileHash,
          patchFileHash: "patch-a",
          patchStorageUri: "storage://patch-a",
        },
        {
          baseBundleId: secondBase.id,
          baseFileHash: secondBase.fileHash,
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
    expect(hydrated?.patchBaseBundleId).toBe(firstBase.id);
    expect(hydrated?.patchFileHash).toBe("patch-a");
    expect(hydrated?.targetCohorts).toEqual(["qa"]);
  });

  it("rejects duplicate patch ids", () => {
    const base = createBundle("base");
    const bundle: Bundle = {
      ...createBundle("target"),
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
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
