import fs from "fs/promises";
import JSZip from "jszip";
import path from "path";
import type { CompressionOptions, CompressionService } from "./types";

/**
 * ZIP compression service implementation.
 * Uses JSZip to create standard ZIP archives with DEFLATE compression.
 */
export class ZipCompressionService implements CompressionService {
  private readonly options: CompressionOptions;

  constructor(options: CompressionOptions = {}) {
    this.options = options;
  }

  async compress(inputDir: string, outputFile: string): Promise<void> {
    const zip = new JSZip();
    const excludeExts = this.options.excludeExts || [];

    // Remove existing output file if it exists
    await fs.rm(outputFile, { force: true });

    // Recursively add files to the zip archive
    const addFiles = async (dir: string, zipFolder: JSZip): Promise<void> => {
      const files = await fs.readdir(dir);
      files.sort(); // Sort for deterministic output

      for (const file of files) {
        // Skip excluded files
        if (excludeExts.some((pattern) => file.includes(pattern))) {
          continue;
        }

        const fullPath = path.join(dir, file);
        const stats = await fs.stat(fullPath);

        if (stats.isDirectory()) {
          const folder = zipFolder.folder(file);
          if (!folder) {
            continue;
          }
          await addFiles(fullPath, folder);
        } else {
          const data = await fs.readFile(fullPath);
          zipFolder.file(file, data);
        }
      }
    };

    await addFiles(inputDir, zip);

    // Normalize file dates for consistent hashing
    zip.forEach((_, file) => {
      file.date = new Date(0);
    });

    // Generate the zip archive
    const content = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: {
        level: 9, // Maximum compression
      },
      platform: "UNIX",
    });

    // Ensure output directory exists
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    await fs.writeFile(outputFile, content);
  }

  getFileExtension(): string {
    return ".zip";
  }

  getContentEncoding(): string | null {
    // ZIP format handles compression internally, no Content-Encoding needed
    return null;
  }

  getMimeType(): string {
    return "application/zip";
  }
}
