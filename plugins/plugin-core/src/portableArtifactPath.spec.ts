import { describe, expect, it } from "vitest";

import {
  findPortableArtifactPathConflict,
  getBundleArchiveEntryCount,
  getPortableArtifactPathCollisionKey,
  getUtf8ByteSize,
  MAX_BUNDLE_ARCHIVE_ENTRIES,
  MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES,
  MAX_DECLARED_BUNDLE_ARTIFACTS,
} from "./portableArtifactPath";

describe("portable artifact paths", () => {
  it.each([
    ["case", "Asset.bin", "asset.bin"],
    ["NFC and NFD", "café.png", "cafe\u0301.png"],
    ["full case fold sharp s", "Straße.json", "STRASSE.json"],
    ["full case fold final sigma", "μέρος.json", "ΜΈΡΟσ.json"],
  ])("uses one collision key for %s equivalents", (_, left, right) => {
    expect(getPortableArtifactPathCollisionKey(left)).toBe(
      getPortableArtifactPathCollisionKey(right),
    );
  });

  it("finds file and descendant conflicts after portable canonicalization", () => {
    expect(
      findPortableArtifactPathConflict(["strasse/entry.lynxbc", "Straße"]),
    ).toEqual({
      kind: "ancestor",
      ancestor: "Straße",
      descendant: "strasse/entry.lynxbc",
    });
  });

  it.each([
    ["case", "A/x.bin", "a/y.bin", "A", "a"],
    ["NFC", "café/x.bin", "cafe\u0301/y.bin", "café", "cafe\u0301"],
    ["full case fold", "Straße/x.bin", "strasse/y.bin", "Straße", "strasse"],
  ])(
    "finds %s collisions between implicit parent directories",
    (_, first, second, firstDirectory, secondDirectory) => {
      expect(findPortableArtifactPathConflict([first, second])).toEqual({
        kind: "directory-alias",
        first: firstDirectory,
        second: secondDirectory,
      });
      expect(findPortableArtifactPathConflict([second, first])).toEqual({
        kind: "directory-alias",
        first: secondDirectory,
        second: firstDirectory,
      });
    },
  );

  it("allows multiple files under the same exact parent directory", () => {
    expect(findPortableArtifactPathConflict(["A/x.bin", "A/y.bin"])).toBeNull();
  });

  it("exports the native artifact count and UTF-8 path boundaries", () => {
    expect(MAX_BUNDLE_ARCHIVE_ENTRIES).toBe(10_000);
    expect(MAX_DECLARED_BUNDLE_ARTIFACTS).toBe(9_999);
    expect(MAX_DECLARED_BUNDLE_ARTIFACTS + 1).toBe(MAX_BUNDLE_ARCHIVE_ENTRIES);
    expect(MAX_BUNDLE_ARTIFACT_PATH_UTF8_BYTES).toBe(1024);
    expect(getUtf8ByteSize("é".repeat(512))).toBe(1024);
    expect(getUtf8ByteSize(`${"é".repeat(512)}a`)).toBe(1025);
  });

  it("counts generated manifest and unique archive directories", () => {
    const flatBoundary = Array.from(
      { length: MAX_DECLARED_BUNDLE_ARTIFACTS },
      (_, index) => `file-${index}`,
    );
    expect(getBundleArchiveEntryCount(flatBoundary)).toBe(
      MAX_BUNDLE_ARCHIVE_ENTRIES,
    );
    expect(getBundleArchiveEntryCount([...flatBoundary, "overflow"])).toBe(
      MAX_BUNDLE_ARCHIVE_ENTRIES + 1,
    );

    const tooManyDirectories = Array.from(
      { length: 5_000 },
      (_, index) => `dir-${index}/entry`,
    );
    expect(getBundleArchiveEntryCount(tooManyDirectories)).toBe(10_001);

    const nestedBoundary = [
      ...Array.from({ length: 4_999 }, (_, index) => `dir-${index}/entry`),
      "root-entry",
    ];
    expect(getBundleArchiveEntryCount(nestedBoundary)).toBe(
      MAX_BUNDLE_ARCHIVE_ENTRIES,
    );
  });
});
