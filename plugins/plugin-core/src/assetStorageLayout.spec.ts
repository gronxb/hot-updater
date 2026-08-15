import { describe, expect, it } from "vitest";

import {
  createStorageUriWithRelativePath,
  getAssetStorageLayout,
  getManifestAssetDownloadPath,
  getManifestAssetStoragePath,
  replaceStorageUriKeySuffix,
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
        baseStorageUri: "s3://bucket/releases/assets",
        relativePath: "assets/icon one.png",
      }),
    ).toBe("s3://bucket/releases/assets/assets/icon%20one.png");
  });

  it("round-trips a canonical base and child with special characters", () => {
    expect(
      createStorageUriWithRelativePath({
        baseStorageUri: "r2://updates/releases/%ED%95%9C%EA%B8%80%20bundle",
        relativePath: "assets/icon #100%.png",
      }),
    ).toBe(
      "r2://updates/releases/%ED%95%9C%EA%B8%80%20bundle/assets/icon%20%23100%25.png",
    );
  });

  it.each(["../asset.png", "assets/./logo.png", "assets\\logo.png", "//"])(
    "rejects an ambiguous relative path %s",
    (relativePath) => {
      expect(() =>
        createStorageUriWithRelativePath({
          baseStorageUri: "s3://bucket/releases/assets",
          relativePath,
        }),
      ).toThrow();
    },
  );

  it("replaces a canonical key suffix at decoded segment boundaries", () => {
    expect(
      replaceStorageUriKeySuffix({
        storageUri:
          "s3://bucket/releases/%ED%95%9C%EA%B8%80%20bundle/bundle%20%231.zip",
        keySuffix: "한글 bundle/bundle #1.zip",
        replacement: "assets",
      }),
    ).toBe("s3://bucket/releases/assets");
  });

  it.each([
    ["missing.zip", "assets"],
    ["bundle.zip", ""],
    ["bundle.zip", "../assets"],
    ["bundle.zip", "files\\assets"],
  ])(
    "rejects an invalid suffix/replacement %s -> %s",
    (keySuffix, replacement) => {
      expect(() =>
        replaceStorageUriKeySuffix({
          storageUri: "s3://bucket/releases/bundle.zip",
          keySuffix,
          replacement,
        }),
      ).toThrow();
    },
  );

  it("resolves manifest asset storage uris through the layout entrypoint", () => {
    expect(
      resolveManifestAssetStorageUri({
        assetBaseStorageUri: "s3://bucket/assets",
        assetPath: "assets/logo.png",
        fileHash: "abcdef",
      }),
    ).toBe("s3://bucket/assets/sha256/ab/abcdef.png");
  });

  it("uses one physical download-name rule for bundle assets", () => {
    expect(getManifestAssetDownloadPath("index.ios.bundle")).toBe(
      "index.ios.bundle.br",
    );
    expect(getManifestAssetDownloadPath("nested/index.android.bundle")).toBe(
      "nested/index.android.bundle.br",
    );
    expect(getManifestAssetDownloadPath("main.ios.bundle")).toBe(
      "main.ios.bundle",
    );
  });
});
