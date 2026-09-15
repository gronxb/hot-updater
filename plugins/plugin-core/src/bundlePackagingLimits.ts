export const MAX_BUNDLE_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MAX_BUNDLE_EXPANDED_BYTES = 512 * 1024 * 1024;
export const MAX_BUNDLE_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const MAX_BUNDLE_MANIFEST_BYTES = 1024 * 1024;

const TAR_BLOCK_BYTES = 512;
const MAX_TAR_DATA_PADDING_BYTES = TAR_BLOCK_BYTES - 1;
// A 1,024-byte path plus portable mtime/size PAX fields occupies at most 3 blocks.
const MAX_TAR_PAX_BODY_BYTES = 3 * TAR_BLOCK_BYTES;
const MAX_TAR_ENTRY_FRAMING_BYTES =
  TAR_BLOCK_BYTES +
  MAX_TAR_DATA_PADDING_BYTES +
  TAR_BLOCK_BYTES +
  MAX_TAR_PAX_BODY_BYTES;
const TAR_END_BLOCK_BYTES = 2 * TAR_BLOCK_BYTES;

/**
 * Worst-case framing for 10,000 entries: entry headers, data padding, one
 * optional PAX/long-name header and body per entry, plus two TAR end blocks.
 */
export const MAX_BUNDLE_TAR_FRAMING_BYTES =
  MAX_BUNDLE_ARCHIVE_ENTRIES * MAX_TAR_ENTRY_FRAMING_BYTES +
  TAR_END_BLOCK_BYTES;

/** Decoded TAR stream ceiling; logical extracted files remain capped at 512 MiB. */
export const MAX_BUNDLE_TAR_STREAM_BYTES =
  MAX_BUNDLE_EXPANDED_BYTES + MAX_BUNDLE_TAR_FRAMING_BYTES;

export const getMaximumBundleTarStreamByteSize = (
  logicalByteSize: number,
  archiveEntryCount: number,
): number =>
  logicalByteSize +
  archiveEntryCount * MAX_TAR_ENTRY_FRAMING_BYTES +
  TAR_END_BLOCK_BYTES;

const assertByteSizeWithinLimit = (
  byteSize: number | bigint,
  limit: number,
  message: string,
) => {
  const valid =
    typeof byteSize === "bigint"
      ? byteSize >= 0n && byteSize <= BigInt(limit)
      : Number.isSafeInteger(byteSize) && byteSize >= 0 && byteSize <= limit;
  if (!valid) throw new Error(message);
};

export const assertBundleArtifactByteSize = (
  byteSize: number | bigint,
  artifactName: string,
) =>
  assertByteSizeWithinLimit(
    byteSize,
    MAX_BUNDLE_ARTIFACT_BYTES,
    `Build artifact exceeds ${MAX_BUNDLE_ARTIFACT_BYTES} bytes: ${artifactName}`,
  );

export const assertBundleExpandedByteSize = (byteSize: number | bigint) =>
  assertByteSizeWithinLimit(
    byteSize,
    MAX_BUNDLE_EXPANDED_BYTES,
    `Bundle expands beyond ${MAX_BUNDLE_EXPANDED_BYTES} bytes`,
  );

export const assertBundleManifestByteSize = (byteSize: number | bigint) =>
  assertByteSizeWithinLimit(
    byteSize,
    MAX_BUNDLE_MANIFEST_BYTES,
    `Bundle manifest exceeds ${MAX_BUNDLE_MANIFEST_BYTES} bytes`,
  );

export const assertBundleArchiveByteSize = (byteSize: number | bigint) =>
  assertByteSizeWithinLimit(
    byteSize,
    MAX_BUNDLE_ARCHIVE_BYTES,
    `Bundle archive exceeds ${MAX_BUNDLE_ARCHIVE_BYTES} bytes`,
  );

export const assertBundleTarStreamByteSize = (byteSize: number | bigint) =>
  assertByteSizeWithinLimit(
    byteSize,
    MAX_BUNDLE_TAR_STREAM_BYTES,
    `Decoded TAR stream exceeds ${MAX_BUNDLE_TAR_STREAM_BYTES} bytes`,
  );
import { MAX_BUNDLE_ARCHIVE_ENTRIES } from "./portableArtifactPath";
