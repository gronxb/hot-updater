export interface ParsedStorageUri {
  protocol: string;
  bucket: string;
  key: string;
}

/**
 * Parses a storage URI and validates the protocol.
 *
 * @param storageUri - The storage URI to parse (e.g., "s3://bucket/path/to/file")
 * @param expectedProtocol - The expected protocol without colon (e.g., "s3", "r2", "gs")
 * @returns Parsed storage URI components
 * @throws Error if the URI is invalid or protocol doesn't match
 *
 * @example
 * ```typescript
 * const { bucket, key } = parseStorageUri("s3://my-bucket/path/to/file.zip", "s3");
 * // bucket: "my-bucket"
 * // key: "path/to/file.zip"
 * ```
 */
export function parseStorageUri(
  storageUri: string,
  expectedProtocol: string,
): ParsedStorageUri {
  try {
    const url = new URL(storageUri);
    const protocol = url.protocol.replace(":", "");

    if (protocol !== expectedProtocol) {
      throw new Error(
        `Invalid storage URI protocol. Expected ${expectedProtocol}, got ${protocol}`,
      );
    }

    return {
      protocol,
      bucket: url.hostname,
      key: url.pathname.slice(1), // Remove leading '/'
    };
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid storage URI format: ${storageUri}`);
    }
    throw error;
  }
}
