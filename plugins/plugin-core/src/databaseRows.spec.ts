import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";

import {
  BundleRowHydrationError,
  BundleRowHydrationErrorReason,
  bundleToPatchRows,
  bundleToRow,
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
  it("round-trips ordered patches and derives the scalar compatibility view", () => {
    // Given
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

    // When
    const [hydrated] = rowsToBundles(
      [bundleToRow(bundle, "channel-production")],
      patchRows,
      [
        bundleToRow(firstBase, "channel-production"),
        bundleToRow(secondBase, "channel-production"),
      ],
      [{ id: "channel-production", name: "production" }],
    );

    // Then
    expect(hydrated?.patches).toEqual(bundle.patches);
    expect(hydrated?.patchBaseBundleId).toBe(firstBase.id);
    expect(hydrated?.patchFileHash).toBe("patch-a");
    expect(hydrated?.targetCohorts).toEqual(["qa"]);
  });

  it("rejects duplicate patch ids", () => {
    // Given
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

    // When
    const hydrate = () =>
      rowsToBundles(
        [bundleToRow(bundle, "channel-production")],
        [patch, patch],
        [bundleToRow(base, "channel-production")],
        [{ id: "channel-production", name: "production" }],
      );

    // Then
    expect(hydrate).toThrowError(
      expect.objectContaining({
        reason: BundleRowHydrationErrorReason.duplicatePatchId,
      }),
    );
  });

  it("rejects orphan owners and bases", () => {
    // Given
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

    // When
    const channels = [{ id: "channel-production", name: "production" }];
    const orphanOwner = () =>
      rowsToBundles(
        [],
        [patch],
        [bundleToRow(base, "channel-production")],
        channels,
      );
    const orphanBase = () =>
      rowsToBundles(
        [bundleToRow(target, "channel-production")],
        [patch],
        [],
        channels,
      );

    // Then
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
