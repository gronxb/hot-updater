export interface ParsedStorageUri {
  readonly protocol: string;
  readonly bucket: string;
  readonly key: string;
}

export interface CreateStorageUriInput {
  readonly protocol: string;
  readonly bucket: string;
  readonly key: string;
}

const PROTOCOL_PATTERN = /^[a-z][a-z\d+.-]*$/;
const INVALID_BUCKET_CHARACTER_PATTERN = /[\s/?#%@:\\]/;

const assertProtocol = (protocol: string) => {
  if (!PROTOCOL_PATTERN.test(protocol)) {
    throw new Error(`Invalid storage URI protocol: ${protocol}`);
  }
};

const assertBucket = (bucket: string) => {
  if (bucket.length === 0 || INVALID_BUCKET_CHARACTER_PATTERN.test(bucket)) {
    throw new Error(`Invalid storage URI bucket: ${bucket}`);
  }
};

const getKeySegments = (key: string) => {
  if (key.length === 0) {
    throw new Error("Invalid storage URI key: key must not be empty");
  }
  const segments = key.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\"),
    )
  ) {
    throw new Error(
      "Invalid storage URI key: segments must not be empty, '.', '..' or contain '\\'",
    );
  }
  return segments;
};

/**
 * Creates a hierarchical storage identifier in the form
 * `protocol://bucket/slash-separated-encoded-key`.
 */
export const createStorageUri = ({
  protocol,
  bucket,
  key,
}: CreateStorageUriInput): string => {
  assertProtocol(protocol);
  assertBucket(bucket);
  const encodedKey = getKeySegments(key).map(encodeURIComponent).join("/");
  return `${protocol}://${bucket}/${encodedKey}`;
};

/**
 * Parses a hierarchical storage identifier and decodes each key segment.
 *
 * Search parameters and fragments are not part of a storage identifier.
 */
export function parseStorageUri(
  storageUri: string,
  expectedProtocol: string,
): ParsedStorageUri {
  assertProtocol(expectedProtocol);
  if (storageUri.includes("?") || storageUri.includes("#")) {
    throw new Error(`Invalid storage URI format: ${storageUri}`);
  }

  const match = /^([a-z][a-z\d+.-]*):\/\/([^/]+)\/(.*)$/.exec(storageUri);
  if (!match) {
    throw new Error(`Invalid storage URI format: ${storageUri}`);
  }

  const [, protocol, bucket, encodedKey] = match;
  if (protocol !== expectedProtocol) {
    throw new Error(
      `Invalid storage URI protocol. Expected ${expectedProtocol}, got ${protocol}`,
    );
  }
  assertBucket(bucket);

  let segments: string[];
  try {
    segments = getKeySegments(encodedKey).map((segment) => {
      const decoded = decodeURIComponent(segment);
      if (decoded.includes("/") || decoded.includes("\\")) {
        throw new Error("encoded hierarchy separator");
      }
      if (encodeURIComponent(decoded) !== segment) {
        throw new Error("non-canonical segment");
      }
      return decoded;
    });
  } catch {
    throw new Error(`Invalid storage URI format: ${storageUri}`);
  }

  return { protocol, bucket, key: segments.join("/") };
}
