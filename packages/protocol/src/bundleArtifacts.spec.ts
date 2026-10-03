import { describe, expect, it } from "vitest";

import {
  getBundlePatch,
  getBundlePatches,
  getManifestContentHash,
  isArtifactIntegrityToken,
  getPatchBaseBundleId,
  getPatchBaseFileHash,
  getPatchFileHash,
  getPatchStorageUri,
} from "./bundleArtifacts";

const manifestContentHash = "a".repeat(64);

const patches = [
  {
    baseBundleId: "primary-base",
    baseFileHash: "primary-base-hash",
    patchFileHash: "primary-patch-hash",
    patchStorageUri: "storage://primary.patch",
    byteSize: 101,
  },
  {
    baseBundleId: "secondary-base",
    baseFileHash: "secondary-base-hash",
    patchFileHash: "secondary-patch-hash",
    patchStorageUri: "storage://secondary.patch",
    byteSize: 202,
  },
] as const;

describe("bundle patch artifacts", () => {
  it("uses the ordered patch collection as the only patch source", () => {
    const bundle = { patches: [...patches] };

    expect(getBundlePatches(bundle)).toEqual(patches);
    expect(getBundlePatch(bundle, "secondary-base")).toEqual(patches[1]);
    expect(getPatchBaseBundleId(bundle)).toBe("primary-base");
    expect(getPatchBaseFileHash(bundle)).toBe("primary-base-hash");
    expect(getPatchFileHash(bundle)).toBe("primary-patch-hash");
    expect(getPatchStorageUri(bundle)).toBe("storage://primary.patch");
  });

  it("keeps the first artifact for each base bundle", () => {
    const duplicate = {
      ...patches[0],
      patchFileHash: "duplicate-hash",
      patchStorageUri: "storage://duplicate.patch",
    };

    expect(getBundlePatches({ patches: [...patches, duplicate] })).toEqual(
      patches,
    );
  });

  it("returns null patch views when no artifacts exist", () => {
    const bundle = { patches: [] };

    expect(getBundlePatch(bundle, "missing")).toBeNull();
    expect(getPatchBaseBundleId(bundle)).toBeNull();
    expect(getPatchBaseFileHash(bundle)).toBeNull();
    expect(getPatchFileHash(bundle)).toBeNull();
    expect(getPatchStorageUri(bundle)).toBeNull();
  });
});

describe("manifest content hash", () => {
  it("uses explicit raw metadata for a signed manifest", () => {
    expect(
      getManifestContentHash({
        manifestFileHash: "sig:c2lnbmF0dXJl",
        metadata: { manifest_content_hash: manifestContentHash },
      }),
    ).toBe(manifestContentHash);
  });

  it("uses the plain manifest hash for an unsigned legacy bundle", () => {
    expect(
      getManifestContentHash({
        manifestFileHash: manifestContentHash,
        metadata: {},
      }),
    ).toBe(manifestContentHash);
  });

  it("ignores metadata when manifestFileHash is already a plain hash", () => {
    expect(
      getManifestContentHash({
        manifestFileHash: manifestContentHash,
        metadata: { manifest_content_hash: "b".repeat(64) },
      }),
    ).toBe(manifestContentHash);
  });

  it("rejects invalid metadata and signed values as content hashes", () => {
    expect(
      getManifestContentHash({
        manifestFileHash: "sig:c2lnbmF0dXJl",
        metadata: { manifest_content_hash: "not-a-sha256" },
      }),
    ).toBeNull();
  });

  it.each([
    "not-a-signature",
    "sig:",
    "sig:not-base64",
    "sig:abcde",
    "SIG:c2lnbmF0dXJl",
  ])("rejects malformed signature token %s even with metadata", (token) => {
    expect(
      getManifestContentHash({
        manifestFileHash: token,
        metadata: { manifest_content_hash: manifestContentHash },
      }),
    ).toBeNull();
  });
});

describe("artifact integrity token", () => {
  it.each(["a".repeat(64), "sig:c2lnbmF0dXJl"])(
    "accepts canonical token %s",
    (token) => {
      expect(isArtifactIntegrityToken(token)).toBe(true);
    },
  );

  it.each(["A".repeat(64), "sig:", "sig:not-base64", "malformed"])(
    "rejects malformed token %s",
    (token) => {
      expect(isArtifactIntegrityToken(token)).toBe(false);
    },
  );
});
