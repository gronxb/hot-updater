import crypto from "node:crypto";

import type { BundleManifest, BundleManifestAsset } from "@hot-updater/core";
import {
  isContentAddressedAssetFileHash,
  MAX_BUNDLE_ARTIFACT_BYTES,
} from "@hot-updater/plugin-core";

import { hasCanonicalManifestAssetPaths } from "./manifestAssetPath";

const isByteSize = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAX_BUNDLE_ARTIFACT_BYTES;

export const getSha256 = (bytes: Uint8Array | string) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

const isBundleManifestAsset = (
  value: unknown,
): value is BundleManifestAsset => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const asset = value as Record<string, unknown>;
  return (
    isContentAddressedAssetFileHash(asset.fileHash) &&
    (asset.downloadCompression === undefined ||
      asset.downloadCompression === null ||
      asset.downloadCompression === "br") &&
    (asset.downloadFileHash === undefined ||
      isContentAddressedAssetFileHash(asset.downloadFileHash)) &&
    (asset.downloadByteSize === undefined ||
      isByteSize(asset.downloadByteSize)) &&
    (asset.signature === undefined || typeof asset.signature === "string")
  );
};

export const isBundleManifest = (value: unknown): value is BundleManifest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const manifest = value as Record<string, unknown>;
  if (
    typeof manifest.bundleId !== "string" ||
    (manifest.patchAssetPath !== undefined &&
      typeof manifest.patchAssetPath !== "string") ||
    !manifest.assets ||
    typeof manifest.assets !== "object" ||
    Array.isArray(manifest.assets)
  ) {
    return false;
  }

  const assets = manifest.assets as Record<string, unknown>;
  return (
    hasCanonicalManifestAssetPaths({
      assetPaths: Object.keys(assets),
      patchAssetPath:
        typeof manifest.patchAssetPath === "string"
          ? manifest.patchAssetPath
          : undefined,
    }) && Object.values(assets).every(isBundleManifestAsset)
  );
};

export const parseStoredBundleManifest = ({
  bundleId,
  manifestBytes,
  manifestContentHash,
}: {
  bundleId: string;
  manifestBytes: Uint8Array;
  manifestContentHash: unknown;
}): BundleManifest | null => {
  if (
    !isContentAddressedAssetFileHash(manifestContentHash) ||
    getSha256(manifestBytes) !== manifestContentHash
  ) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
  } catch {
    return null;
  }

  return isBundleManifest(payload) && payload.bundleId === bundleId
    ? payload
    : null;
};

export const hasVerifiedDownloadRepresentation = (
  asset: BundleManifestAsset,
  bytes: Uint8Array,
) => {
  if (
    asset.downloadCompression === undefined ||
    !isByteSize(asset.downloadByteSize) ||
    bytes.byteLength !== asset.downloadByteSize
  ) {
    return false;
  }

  const expectedHash =
    asset.downloadFileHash ??
    (asset.downloadCompression === null ? asset.fileHash : null);
  return expectedHash !== null && getSha256(bytes) === expectedHash;
};

export const hasExplicitDownloadRepresentation = (asset: BundleManifestAsset) =>
  asset.downloadCompression !== undefined &&
  isByteSize(asset.downloadByteSize) &&
  (isContentAddressedAssetFileHash(asset.downloadFileHash) ||
    (asset.downloadCompression === null &&
      asset.downloadFileHash === undefined));

export const hasVerifiedLogicalAsset = (
  asset: BundleManifestAsset,
  bytes: Uint8Array,
) => getSha256(bytes) === asset.fileHash;
