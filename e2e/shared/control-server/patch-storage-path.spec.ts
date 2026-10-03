import { describe, expect, it } from "vitest";

import { inferPatchAssetPathFromStorageUri } from "./patch-storage-path.ts";

describe("patch storage path", () => {
  const baseBundleId = "base-bundle-id";
  const patchFileHash = "a".repeat(64);

  it("removes the content-addressed patch hash from the asset path", () => {
    expect(
      inferPatchAssetPathFromStorageUri({
        baseBundleId,
        patchFileHash,
        patchStorageUri: `s3://bucket/bundles/target/patches/${baseBundleId}/${patchFileHash}/nested/index.ios.bundle.bsdiff`,
      }),
    ).toBe("nested/index.ios.bundle");
  });

  it("keeps decoding the legacy patch storage layout", () => {
    expect(
      inferPatchAssetPathFromStorageUri({
        baseBundleId,
        patchFileHash,
        patchStorageUri: `https://storage.example.com/bundles/target/patches/${baseBundleId}/nested%20assets/index.android.bundle.bsdiff`,
      }),
    ).toBe("nested assets/index.android.bundle");
  });

  it("keeps a path segment that does not match the descriptor hash", () => {
    const otherHash = "b".repeat(64);

    expect(
      inferPatchAssetPathFromStorageUri({
        baseBundleId,
        patchFileHash,
        patchStorageUri: `s3://bucket/bundles/target/patches/${baseBundleId}/${otherHash}/index.ios.bundle.bsdiff`,
      }),
    ).toBe(`${otherHash}/index.ios.bundle`);
  });
});
