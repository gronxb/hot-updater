import { describe, expect, it } from "vitest";

import {
  createStorageUriWithRelativePath,
  getManifestAssetDownloadPath,
  getManifestAssetStoragePath,
  replaceStorageUriKeySuffix,
  resolveManifestAssetStorageFileHash,
  resolveManifestAssetStorageUri,
} from "./assetStorageLayout";

describe("assetStorageLayout", () => {
  it("resolves content-addressed manifest assets by file hash", () => {
    expect(
      getManifestAssetStoragePath({
        assetPath: "index.ios.bundle.br",
        fileHash: "abcdef",
      }),
    ).toBe("sha256/ab/abcdef.br");
  });

  it("uses an exact transferred-file hash for content-addressed storage", () => {
    const fileHash = "a".repeat(64);
    const downloadFileHash = "b".repeat(64);

    expect(
      getManifestAssetStoragePath({
        assetPath: "index.ios.bundle.br",
        downloadFileHash,
        fileHash,
      }),
    ).toBe(`sha256/bb/${downloadFileHash}.br`);
  });

  it.each(["B".repeat(64), "not-a-hash", "", null])(
    "falls back to the logical hash for malformed transferred hash %s",
    (downloadFileHash) => {
      const fileHash = "a".repeat(64);

      expect(
        resolveManifestAssetStorageFileHash({
          downloadFileHash,
          fileHash,
        }),
      ).toBe(fileHash);
    },
  );

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

  it("resolves transferred payload uris through the layout entrypoint", () => {
    const fileHash = "a".repeat(64);
    const downloadFileHash = "b".repeat(64);

    expect(
      resolveManifestAssetStorageUri({
        assetBaseStorageUri: "s3://bucket/assets",
        assetPath: "index.ios.bundle.br",
        downloadFileHash,
        fileHash,
      }),
    ).toBe(`s3://bucket/assets/sha256/bb/${downloadFileHash}.br`);
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
