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
  /** Transferred patch bytes, used as a conservative installation cost hint. */
  byteSize?: number;
}

/** Authenticated by the target manifest; always describes bundle.tar.br. */
export interface ManifestArchive {
  downloadFileHash: string;
  downloadByteSize: number;
  tarByteSize: number;
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

/**
 * Artifact protocol in which a device asks for the URLs of only the files it
 * downloads one by one, after reusing local files and choosing the archive.
 */
export const ARTIFACT_FILES_PROTOCOL_VERSION = 2 as const;

/** Paths one artifact files request may resolve; a device splits more. */
export const ARTIFACT_FILES_REQUEST_LIMIT = 100;

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
  /** Manifest artifact protocol used by current native clients. */
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
  /** Optional bulk transport. Hash and sizes come from the verified manifest. */
  archiveUrl?: string;
  /**
   * Full target manifest file map. Protocol v1 requires one original file
   * descriptor for every target asset; patches are optional optimizations.
   */
  assets: Record<string, ArtifactAsset>;
}

/**
 * How a device downloads a Bundle in artifact protocol v2: no URL per file,
 * so the response and its signing stay the same size for any number of files.
 */
export interface ArtifactInfoV2 {
  artifactProtocolVersion: typeof ARTIFACT_FILES_PROTOCOL_VERSION;
  manifestUrl: string;
  /** SHA256 hash of the manifest file, optionally `sig:<base64_signature>`. */
  manifestFileHash: string;
  /** Optional bulk transport. Hash and sizes come from the verified manifest. */
  archiveUrl?: string;
  /** The Hermes bytecode patch from the device's current Bundle, if smaller than its file. */
  patch?: ChangedAssetPatch & { assetPath: string };
}

/** The request body of `POST /artifacts/v2/:bundleId/files`. */
export interface ArtifactFilesRequest {
  /** Manifest asset paths, unique, at most {@link ARTIFACT_FILES_REQUEST_LIMIT}. */
  paths: string[];
}

/** Download URLs for the requested manifest asset paths. */
export interface ArtifactFiles {
  files: Record<string, ArtifactAssetFile>;
}
