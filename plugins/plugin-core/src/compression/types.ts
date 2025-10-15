import type { CompressStrategy } from "@hot-updater/core";

/**
 * Compression metadata for a specific compression strategy.
 * Includes file extension, MIME type, and encoding information.
 */
export interface CompressionMetadata {
  /**
   * File extension for the compressed bundle.
   * @example ".zip", ".tar.br", ".tar.gz"
   */
  extension: string;

  /**
   * MIME type for the compressed bundle.
   * Used in Content-Type headers when serving files.
   * @example "application/zip", "application/x-tar"
   */
  mimeType: string;

  /**
   * Content encoding applied to the bundle.
   * Used in Content-Encoding headers when serving files.
   * @example "br" for Brotli, "gzip" for Gzip, undefined for ZIP
   */
  encoding?: string;
}

/**
 * Mapping of compression strategies to their metadata.
 */
export const COMPRESSION_METADATA: Record<
  CompressStrategy,
  CompressionMetadata
> = {
  zip: {
    extension: ".zip",
    mimeType: "application/zip",
    encoding: undefined,
  },
  "tar+brotli": {
    extension: ".tar.br",
    mimeType: "application/x-tar",
    encoding: "br",
  },
  "tar+gzip": {
    extension: ".tar.gz",
    mimeType: "application/x-tar",
    encoding: "gzip",
  },
};

/**
 * Options for compression operations.
 */
export interface CompressionOptions {
  /**
   * Compression level (0-11 for Brotli, 0-9 for Gzip, 0-9 for ZIP).
   * Higher values provide better compression but slower performance.
   */
  level?: number;

  /**
   * Additional strategy-specific options.
   */
  additionalOptions?: Record<string, unknown>;
}

/**
 * Compression plugin interface for implementing custom compression strategies.
 * This interface allows for extensibility in supporting additional compression formats.
 */
export interface CompressionPlugin {
  /**
   * The compression strategy this plugin implements.
   */
  strategy: CompressStrategy;

  /**
   * Compresses the source directory into a single archive file.
   *
   * @param sourcePath - Path to the directory containing files to compress
   * @param outputPath - Path where the compressed archive should be written
   * @param options - Optional compression settings
   * @returns Promise that resolves when compression is complete
   */
  compress: (
    sourcePath: string,
    outputPath: string,
    options?: CompressionOptions,
  ) => Promise<void>;

  /**
   * Extracts a compressed archive to a destination directory.
   *
   * @param archivePath - Path to the compressed archive file
   * @param destinationPath - Path where files should be extracted
   * @returns Promise that resolves when extraction is complete
   */
  extract: (archivePath: string, destinationPath: string) => Promise<void>;

  /**
   * Gets metadata for this compression strategy.
   *
   * @returns Compression metadata including extension, MIME type, and encoding
   */
  getMetadata: () => CompressionMetadata;
}

/**
 * Factory function type for creating compression plugins.
 */
export type CompressionPluginFactory = (
  strategy: CompressStrategy,
) => CompressionPlugin;
