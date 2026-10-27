/**
 * Random access to an artifact's bytes, so a reader takes only the parts it
 * needs of a file of hundreds of megabytes: a file on disk (Node's
 * `fs.openAsBlob`), or bytes in memory.
 */
export interface ByteSource {
  /** The artifact's length in bytes. */
  readonly size: number;
  /** The bytes in `[offset, offset + length)`, fewer only at the end. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A `Blob`, such as Node's `fs.openAsBlob`, read by slices. */
export const blobSource = (blob: Blob): ByteSource => ({
  size: blob.size,
  async read(offset, length) {
    return new Uint8Array(
      await blob
        .slice(offset, Math.min(blob.size, offset + length))
        .arrayBuffer(),
    );
  },
});

/** Bytes already in memory. */
export const bytesSource = (bytes: Uint8Array): ByteSource => ({
  size: bytes.byteLength,
  async read(offset, length) {
    return bytes.subarray(offset, Math.min(bytes.byteLength, offset + length));
  },
});

/** Why an artifact can't be read, or can't serve as a native build. */
export class NativeArtifactError extends Error {
  override readonly name = "NativeArtifactError";

  constructor(
    readonly code: NativeArtifactProblemCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * What can keep an artifact from being imported as a native build: the
 * codes `native-build import --json` reports.
 */
export type NativeArtifactProblemCode =
  | "UNSUPPORTED_FILE"
  | "UNREADABLE"
  | "NO_BUILT_IN_BUNDLE"
  | "NO_MIN_BUNDLE_ID"
  | "AMBIGUOUS_MIN_BUNDLE_ID"
  | "NO_FINGERPRINT"
  | "AMBIGUOUS_FINGERPRINT"
  | "NO_APP_VERSION"
  | "INVALID_SCOPE"
  | "APP_ID_MISMATCH"
  | "ALREADY_IMPORTED";
