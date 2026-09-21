import { describe, expect, it } from "vitest";

import {
  createBundleStorageKey,
  createStorageRootUriWithPath,
  getBundleArchiveStorageUri,
} from "./bundleStorageLayout";

describe("bundle storage layout", () => {
  it("resolves the fixed tar.br sibling without corrupting encoded prefixes", () => {
    expect(
      getBundleArchiveStorageUri({
        manifestStorageUri:
          "s3://bucket/release%20files%23100%25/bundles/bundle-id/manifest.json",
        bundleId: "bundle-id",
      }),
    ).toBe(
      "s3://bucket/release%20files%23100%25/bundles/bundle-id/bundle.tar.br",
    );
    expect(() =>
      getBundleArchiveStorageUri({
        manifestStorageUri: "s3://bucket/bundles/other-id/manifest.json",
        bundleId: "bundle-id",
      }),
    ).toThrow();
  });
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
