export type Platform = "ios" | "android";

export type BundleMetadata = {
  app_version?: string;
};

export interface BundlePatchArtifact {
  baseBundleId: string;
  baseFileHash: string;
  byteSize: number;
  patchFileHash: string;
  patchStorageUri: string;
}

export interface ChangedAssetPatch {
  algorithm: "bsdiff";
  baseBundleId: string;
  baseFileHash: string;
  patchFileHash: string;
  patchUrl: string;
}

export interface ChangedAssetFile {
  compression?: "br" | null;
  url: string;
}

export interface ChangedAsset {
  file?: ChangedAssetFile | null;
  fileHash: string;
  patch?: ChangedAssetPatch | null;
}

export interface Bundle {
  /**
   * The unique identifier for the bundle. uuidv7
   */
  id: string;
  /**
   * The platform the bundle is for.
   */
  platform: Platform;
  /**
   * The hash of the bundle.
   */
  fileHash: string;
  /**
   * The storage key of the bundle.
   * @example "s3://my-bucket/my-app/00000000-0000-0000-0000-000000000000/bundle.zip"
   * @example "r2://my-bucket/my-app/00000000-0000-0000-0000-000000000000/bundle.zip"
   * @example "firebase-storage://my-bucket/my-app/00000000-0000-0000-0000-000000000000/bundle.zip"
   * @example "storage://my-app/00000000-0000-0000-0000-000000000000/bundle.zip"
   */
  storageUri: string;
  /**
   * Byte length of the stored bundle archive.
   */
  archiveByteSize: number;
  /**
   * The git commit hash of the bundle.
   */
  gitCommitHash: string | null;
  /**
   * The metadata of the bundle.
   */
  metadata?: BundleMetadata;

  /**
   * Storage URI for the bundle manifest artifact.
   */
  manifestStorageUri?: string | null;

  /**
   * SHA256 hash of the manifest artifact, optionally signed as sig:<signature>.
   */
  manifestFileHash?: string | null;

  /**
   * Storage URI prefix for manifest assets.
   */
  assetBaseStorageUri?: string | null;

  /**
   * Binary patch artifacts keyed by base bundle in array order.
   * Earlier entries take precedence when a single "primary" patch is needed.
   */
  patches?: BundlePatchArtifact[] | null;
}

export type UpdateStatus = "ROLLBACK" | "UPDATE";

export interface ArtifactInfo {
  fileUrl: string | null;
  /**
   * SHA256 hash of the bundle file, optionally with embedded signature.
   * Format when signed: "sig:<base64_signature>"
   * Format when unsigned: "<hex_hash>" (64-character lowercase hex)
   * The client parses this to extract signature for native verification.
   */
  fileHash: string | null;
  /**
   * Optional manifest artifact for manifest-driven updates.
   * When present with `changedAssets`, native can download and verify a signed
   * manifest, then assemble the next bundle directory from reused and changed
   * files while keeping archive fallback available through `fileUrl`.
   */
  manifestUrl?: string | null;
  /**
   * SHA256 hash of the manifest file, optionally with embedded signature.
   * Follows the same `sig:<base64_signature>` or plain hex format as `fileHash`.
   */
  manifestFileHash?: string | null;
  /**
   * Per-file descriptors for assets whose hash differs from the client's
   * current manifest, or for all assets when the server cannot reuse a base
   * manifest. Keys are manifest-relative file paths.
   */
  changedAssets?: Record<string, ChangedAsset> | null;
}
