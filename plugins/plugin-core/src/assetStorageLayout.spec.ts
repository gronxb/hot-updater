import { describe, expect, it } from "vitest";

import {
  createStorageUriWithRelativePath,
  getAssetStorageLayout,
  getManifestAssetStoragePath,
  resolveManifestAssetStorageUri,
} from "./assetStorageLayout";

describe("assetStorageLayout", () => {
  it("classifies /assets roots as content-addressed storage", () => {
    expect(getAssetStorageLayout("s3://bucket/assets")).toBe(
      "content-addressed",
    );
    expect(getAssetStorageLayout("s3://bucket/releases/assets/")).toBe(
      "content-addressed",
    );
  });

  it("classifies non-/assets roots as legacy per-bundle file storage", () => {
    expect(getAssetStorageLayout("s3://bucket/releases/bundle-id/files")).toBe(
      "legacy-files",
    );
  });

  it("resolves content-addressed manifest assets by file hash", () => {
    expect(
      getManifestAssetStoragePath({
        assetBaseStorageUri: "s3://bucket/assets",
        assetPath: "index.ios.bundle.br",
        fileHash: "abcdef",
      }),
    ).toBe("sha256/ab/abcdef.br");
  });

  it("resolves legacy manifest assets by manifest-relative path", () => {
    expect(
      getManifestAssetStoragePath({
        assetBaseStorageUri: "s3://bucket/releases/bundle-id/files",
        assetPath: "assets/logo.png",
        fileHash: "abcdef",
      }),
    ).toBe("assets/logo.png");
  });

  it("creates escaped child storage uris", () => {
    expect(
      createStorageUriWithRelativePath({
        baseStorageUri: "s3://bucket/releases/assets/",
        relativePath: "assets/icon one.png",
      }),
    ).toBe("s3://bucket/releases/assets/assets/icon%20one.png");
  });

  it("resolves manifest asset storage uris through the layout entrypoint", () => {
    expect(
      resolveManifestAssetStorageUri({
        assetBaseStorageUri: "s3://bucket/assets",
        assetPath: "assets/logo.png",
        fileHash: "abcdef",
      }),
    ).toBe("s3://bucket/assets/sha256/ab/abcdef.png");
  });
});
