import { describe, expect, it } from "vitest";

import {
  compareBundlePatches,
  patchMatchesWhere,
} from "./databaseRuntimeFilters";
import type { DatabaseBundlePatch } from "./types";

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

describe("database runtime filters", () => {
  it("matches bundle patches with the shared where predicate", () => {
    const currentPatch = patch("bundle-1", "base-1", 0);

    expect(
      patchMatchesWhere(currentPatch, {
        id: "bundle-1:base-1",
        idIn: ["bundle-1:base-1"],
        bundleId: "bundle-1",
        baseBundleId: "base-1",
        bundleIdIn: ["bundle-1"],
        baseBundleIdIn: ["base-1"],
      }),
    ).toBe(true);
    expect(
      patchMatchesWhere(currentPatch, {
        idIn: [],
      }),
    ).toBe(false);
  });

  it("sorts bundle patches by order index with patch id as tie breaker", () => {
    const patches = [
      patch("bundle-2", "base-2", 1),
      patch("bundle-1", "base-2", 0),
      patch("bundle-1", "base-1", 0),
    ];

    expect(patches.toSorted(compareBundlePatches)).toStrictEqual([
      patch("bundle-1", "base-1", 0),
      patch("bundle-1", "base-2", 0),
      patch("bundle-2", "base-2", 1),
    ]);
  });
});
