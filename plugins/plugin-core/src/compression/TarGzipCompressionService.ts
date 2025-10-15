import fs from "fs/promises";
import path from "path";
import { createWriteStream } from "fs";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import tar from "tar-stream";
import type { CompressionOptions, CompressionService } from "./types";

/**
 * TAR + Gzip compression service implementation.
 * Uses tar-stream and Node.js native zlib modules.
 * Gzip provides good compression with wide compatibility.
 */
export class TarGzipCompressionService implements CompressionService {
  private readonly options: CompressionOptions;

  constructor(options: CompressionOptions = {}) {
    this.options = options;
  }

  async compress(inputDir: string, outputFile: string): Promise<void> {
    const excludeExts = this.options.excludeExts || [];

    // Remove existing output file if it exists
    await fs.rm(outputFile, { force: true });

    // Ensure output directory exists
    await fs.mkdir(path.dirname(outputFile), { recursive: true });

    const pack = tar.pack();
    const gzipStream = createGzip({
      level: 9, // Maximum compression level
    });
    const writeStream = createWriteStream(outputFile);

    // Pipe: pack -> gzip -> file
    const pipelinePromise = pipeline(pack, gzipStream, writeStream);

    // Add files recursively to the tar archive
    const addFilesToTar = async (
      currentPath: string,
      archivePrefix: string = "",
    ): Promise<void> => {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const archivePath = archivePrefix
          ? path.join(archivePrefix, entry.name)
          : entry.name;

        // Skip excluded files
        if (excludeExts.some((pattern) => entry.name.includes(pattern))) {
          continue;
        }

        if (entry.isDirectory()) {
          await addFilesToTar(fullPath, archivePath);
        } else {
          const data = await fs.readFile(fullPath);
          const stats = await fs.stat(fullPath);
          pack.entry(
            {
              name: archivePath,
              size: data.length,
              mode: stats.mode,
              mtime: new Date(0), // Normalize timestamp for consistent hashing
            },
            data,
          );
        }
      }
    };

    await addFilesToTar(inputDir);
    pack.finalize();
    await pipelinePromise;
  }

  getFileExtension(): string {
    return ".tar.gz";
  }

  getContentEncoding(): string | null {
    return "gzip";
  }

  getMimeType(): string {
    return "application/x-tar";
  }
}
