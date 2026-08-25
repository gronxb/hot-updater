import { describe, expect, it } from "vitest";

import {
  getBundlePatch,
  getBundlePatches,
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
  getPatchStorageUri,
} from "./bundleArtifacts";

const patches = [
  {
    baseBundleId: "primary-base",
    baseFileHash: "primary-base-hash",
    patchFileHash: "primary-patch-hash",
    patchStorageUri: "storage://primary.patch",
    byteSize: 101,
  },
  {
    baseBundleId: "secondary-base",
    baseFileHash: "secondary-base-hash",
    patchFileHash: "secondary-patch-hash",
    patchStorageUri: "storage://secondary.patch",
    byteSize: 202,
  },
] as const;

describe("bundle patch artifacts", () => {
  it("uses the ordered patch collection as the only patch source", () => {
    const bundle = { patches: [...patches] };

    expect(getBundlePatches(bundle)).toEqual(patches);
    expect(getBundlePatch(bundle, "secondary-base")).toEqual(patches[1]);
    expect(getPatchBaseBundleId(bundle)).toBe("primary-base");
    expect(getPatchBaseFileHash(bundle)).toBe("primary-base-hash");
    expect(getPatchFileHash(bundle)).toBe("primary-patch-hash");
    expect(getPatchStorageUri(bundle)).toBe("storage://primary.patch");
  });

  it("keeps the first artifact for each base bundle", () => {
    const duplicate = {
      ...patches[0],
      patchFileHash: "duplicate-hash",
      patchStorageUri: "storage://duplicate.patch",
    };

    expect(getBundlePatches({ patches: [...patches, duplicate] })).toEqual(
      patches,
    );
  });

  it("returns null patch views when no artifacts exist", () => {
    const bundle = { patches: [] };

    expect(getBundlePatch(bundle, "missing")).toBeNull();
    expect(getPatchBaseBundleId(bundle)).toBeNull();
    expect(getPatchBaseFileHash(bundle)).toBeNull();
    expect(getPatchFileHash(bundle)).toBeNull();
    expect(getPatchStorageUri(bundle)).toBeNull();
  });
});
