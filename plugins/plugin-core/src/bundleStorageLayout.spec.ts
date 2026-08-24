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

  it("derives the shared storage root from the canonical bundle namespace", () => {
    expect(
      createStorageRootUriWithPath(
        "s3://bucket/releases/bundles/bundle-id/manifest.json",
        "bundle-id",
        "assets",
      ),
    ).toBe("s3://bucket/releases/assets");
  });

  it.each([
    "https://uploads.example.com/object",
    "s3://bucket/releases/bundle-id/manifest.json",
  ])("rejects a non-canonical bundle storage URI %s", (storageUri) => {
    expect(() =>
      createStorageRootUriWithPath(storageUri, "bundle-id", "assets"),
    ).toThrow("does not contain canonical bundle path: bundles/bundle-id");
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
