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

export interface ArtifactAssetFile {
  compression?: "br" | null;
  url: string;
}

export interface ArtifactAsset {
  file: ArtifactAssetFile;
  fileHash: string;
  patch?: ChangedAssetPatch | null;
}

export const ARTIFACT_PROTOCOL_VERSION = 1 as const;

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
  manifestStorageUri: string;

  /**
   * SHA256 hash of the manifest artifact, optionally signed as sig:<signature>.
   */
  manifestFileHash: string;

  /**
   * Storage URI prefix for manifest assets.
   */
  assetBaseStorageUri: string;

  /**
   * Binary patch artifacts keyed by base bundle in array order.
   * Earlier entries take precedence when a single "primary" patch is needed.
   */
  patches?: BundlePatchArtifact[] | null;
}

export type UpdateStatus = "ROLLBACK" | "UPDATE";

export interface ArtifactInfo {
  /** Manifest-only artifact protocol used by current native clients. */
  artifactProtocolVersion: typeof ARTIFACT_PROTOCOL_VERSION;
  /**
   * Manifest artifact for protocol v1 updates.
   */
  manifestUrl: string;
  /**
   * SHA256 hash of the manifest file, optionally with embedded signature.
   * Uses `sig:<base64_signature>` or a plain SHA256 hash.
   */
  manifestFileHash: string;
  /**
   * Full target manifest file map. Protocol v1 requires one original file
   * descriptor for every target asset; patches are optional optimizations.
   */
  assets: Record<string, ArtifactAsset>;
}
