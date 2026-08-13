import { describe, expect, it } from "vitest";

import {
  createBundleStorageKey,
  createStorageRootUriWithPath,
} from "./bundleStorageLayout";

describe("bundle storage layout", () => {
  it("stores new bundle artifacts below the bundles namespace", () => {
    expect(createBundleStorageKey("bundle-id")).toBe("bundles/bundle-id");
    expect(createBundleStorageKey("bundle-id", "patches", "base-id")).toBe(
      "bundles/bundle-id/patches/base-id",
    );
  });

  it("derives the shared storage root from new and legacy bundle URIs", () => {
    expect(
      createStorageRootUriWithPath(
        "s3://bucket/releases/bundles/bundle-id/manifest.json",
        "bundle-id",
        "assets",
      ),
    ).toBe("s3://bucket/releases/assets");
    expect(
      createStorageRootUriWithPath(
        "s3://bucket/releases/bundle-id/manifest.json",
        "bundle-id",
        "assets",
      ),
    ).toBe("s3://bucket/releases/assets");
  });

  it("preserves encoded storage root segments", () => {
    expect(
      createStorageRootUriWithPath(
        "s3://bucket/release%20files/bundles/bundle-id/manifest.json",
        "bundle-id",
        "assets/sha256",
      ),
    ).toBe("s3://bucket/release%20files/assets/sha256");
  });
});
