import mime from "mime";
import path from "path";

/**
 * Compression format type definition
 */
export type CompressionFormat = "zip" | "tar.br";

/**
 * Compression format metadata
 */
export interface CompressionFormatInfo {
  format: CompressionFormat;
  fileExtension: string;
  contentEncoding?: string; // HTTP Content-Encoding header value
  mimeType?: string;
}

/**
 * Compression formats registry
 * Add new formats here to support additional compression types
 */
const COMPRESSION_FORMATS: Record<CompressionFormat, CompressionFormatInfo> = {
  zip: {
    format: "zip",
    fileExtension: ".zip",
    mimeType: "application/zip",
  },
  "tar.br": {
    format: "tar.br",
    fileExtension: ".tar.br",
    contentEncoding: "br",
    mimeType: "application/x-tar",
  },
};

/**
 * Detects compression format from filename
 * @param filename The filename to detect format from
 * @returns Compression format information
 */
export function detectCompressionFormat(
  filename: string,
): CompressionFormatInfo {
  for (const info of Object.values(COMPRESSION_FORMATS)) {
    if (filename.endsWith(info.fileExtension)) {
      return info;
    }
  }
  // Default to zip if no match
  return COMPRESSION_FORMATS.zip;
}

/**
 * Gets Content-Encoding header value for a filename
 * @param filename The filename to get encoding for
 * @returns Content-Encoding value or undefined if not needed
 */
export function getContentEncoding(filename: string): string | undefined {
  return detectCompressionFormat(filename).contentEncoding;
}

/**
 * Gets MIME type for a filename
 * @param filename The filename to get MIME type for
 * @returns MIME type string
 */
export function getCompressionMimeType(filename: string): string | undefined {
  return detectCompressionFormat(filename).mimeType;
}

/**
 * Gets Content-Type for a bundle file with 3-tier fallback
 * @param bundlePath The bundle file path
 * @returns Content-Type string (never undefined, falls back to application/octet-stream)
 */
export function getContentType(bundlePath: string): string {
  const filename = path.basename(bundlePath);

  return (
    mime.getType(bundlePath) ??
    getCompressionMimeType(filename) ??
    "application/octet-stream"
  );
}
