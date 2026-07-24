import { describe, expect, it } from "vitest";

import {
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
  getPatchStorageUri,
} from "./bundleArtifacts";

const legacyPatch = {
  metadata: {},
  patches: [],
  patchBaseBundleId: "legacy-base",
  patchBaseFileHash: "legacy-base-hash",
  patchFileHash: "legacy-patch-hash",
  patchStorageUri: "storage://legacy.patch",
};

describe("bundle patch compatibility fields", () => {
  it("prefers the first patch over conflicting deprecated scalar fields", () => {
    const bundle = {
      ...legacyPatch,
      patches: [
        {
          baseBundleId: "primary-base",
          baseFileHash: "primary-base-hash",
          patchFileHash: "primary-patch-hash",
          patchStorageUri: "storage://primary.patch",
        },
      ],
    };

    expect(getPatchBaseBundleId(bundle)).toBe("primary-base");
    expect(getPatchBaseFileHash(bundle)).toBe("primary-base-hash");
    expect(getPatchFileHash(bundle)).toBe("primary-patch-hash");
    expect(getPatchStorageUri(bundle)).toBe("storage://primary.patch");
  });

  it("uses deprecated scalar fields only when no patch row exists", () => {
    expect(getPatchBaseBundleId(legacyPatch)).toBe("legacy-base");
    expect(getPatchBaseFileHash(legacyPatch)).toBe("legacy-base-hash");
    expect(getPatchFileHash(legacyPatch)).toBe("legacy-patch-hash");
    expect(getPatchStorageUri(legacyPatch)).toBe("storage://legacy.patch");
  });
});
