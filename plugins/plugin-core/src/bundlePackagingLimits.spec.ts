import { describe, expect, it } from "vitest";

import {
  assertBundleArchiveByteSize,
  assertBundleArtifactByteSize,
  assertBundleExpandedByteSize,
  assertBundleManifestByteSize,
  assertBundleTarStreamByteSize,
  getMaximumBundleTarStreamByteSize,
  MAX_BUNDLE_ARCHIVE_BYTES,
  MAX_BUNDLE_ARTIFACT_BYTES,
  MAX_BUNDLE_EXPANDED_BYTES,
  MAX_BUNDLE_MANIFEST_BYTES,
  MAX_BUNDLE_TAR_FRAMING_BYTES,
  MAX_BUNDLE_TAR_STREAM_BYTES,
} from "./bundlePackagingLimits";

describe("bundle packaging byte limits", () => {
  it("accepts the exact per-artifact boundary and rejects one byte above it", () => {
    expect(() =>
      assertBundleArtifactByteSize(MAX_BUNDLE_ARTIFACT_BYTES, "entry.bin"),
    ).not.toThrow();
    expect(() =>
      assertBundleArtifactByteSize(MAX_BUNDLE_ARTIFACT_BYTES + 1, "entry.bin"),
    ).toThrow();
  });

  it.each([
    ["expanded", assertBundleExpandedByteSize, MAX_BUNDLE_EXPANDED_BYTES],
    ["manifest", assertBundleManifestByteSize, MAX_BUNDLE_MANIFEST_BYTES],
    ["archive", assertBundleArchiveByteSize, MAX_BUNDLE_ARCHIVE_BYTES],
  ] as const)(
    "accepts the exact %s boundary and rejects one byte above it",
    (_, assertSize, limit) => {
      expect(() => assertSize(limit)).not.toThrow();
      expect(() => assertSize(limit + 1)).toThrow();
    },
  );

  it("allows worst-case TAR framing above the exact logical byte limit", () => {
    const maximum = getMaximumBundleTarStreamByteSize(
      MAX_BUNDLE_EXPANDED_BYTES,
      10_000,
    );

    expect(MAX_BUNDLE_TAR_FRAMING_BYTES).toBe(30_711_024);
    expect(maximum).toBe(MAX_BUNDLE_TAR_STREAM_BYTES);
    expect(() => assertBundleTarStreamByteSize(maximum)).not.toThrow();
    expect(() => assertBundleTarStreamByteSize(maximum + 1)).toThrow();
  });
});
