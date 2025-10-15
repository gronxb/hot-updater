import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { createBrotliCompress, createGzip } from "zlib";
import tar from "tar";
import type { CompressionStrategy } from "./types";

export interface CompressionMetadata {
  contentEncoding: string;
  contentType: string;
  fileExtension: string;
}

/**
 * Get compression metadata based on the compression strategy
 */
export function getCompressionMetadata(
  strategy: CompressionStrategy,
): CompressionMetadata {
  switch (strategy) {
    case "zip":
      return {
        contentEncoding: "identity",
        contentType: "application/zip",
        fileExtension: ".zip",
      };
    case "tarBrotli":
      return {
        contentEncoding: "br",
        contentType: "application/x-tar",
        fileExtension: ".tar.br",
      };
    case "tarGzip":
      return {
        contentEncoding: "gzip",
        contentType: "application/x-tar",
        fileExtension: ".tar.gz",
      };
  }
}

/**
 * Create a tar archive from target files or directories
 */
async function createTar(
  targetFiles: { path: string; name: string }[],
  tarPath: string,
): Promise<void> {
  await fs.rm(tarPath, { force: true });
  await fs.mkdir(path.dirname(tarPath), { recursive: true });

  // Create tar archive using the tar library
  await tar.create(
    {
      file: tarPath,
      cwd: path.dirname(targetFiles[0]?.path ?? process.cwd()),
      portable: true,
      noMtime: true, // Ensures consistent hashes
    },
    targetFiles.map((f) => {
      // Calculate relative path from base directory
      const basePath = path.dirname(f.path);
      const relativePath = path.relative(basePath, f.path);
      return relativePath || f.name;
    }),
  );
}

/**
 * Compress a tar file with brotli
 */
async function compressBrotli(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const input = createReadStream(inputPath);
  const output = createWriteStream(outputPath);
  const brotli = createBrotliCompress({
    params: {
      // Maximum compression level for best size reduction
      [require("zlib").constants.BROTLI_PARAM_QUALITY]: 11,
    },
  });

  await pipeline(input, brotli, output);
  await fs.rm(inputPath, { force: true });
}

/**
 * Compress a tar file with gzip
 */
async function compressGzip(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const input = createReadStream(inputPath);
  const output = createWriteStream(outputPath);
  const gzip = createGzip({
    level: 9, // Maximum compression level
  });

  await pipeline(input, gzip, output);
  await fs.rm(inputPath, { force: true });
}

/**
 * Create tar+brotli compressed bundle from target files
 */
export async function createTarBrotli({
  outfile,
  targetFiles,
}: {
  targetFiles: { path: string; name: string }[];
  outfile: string;
}): Promise<string> {
  const tarPath = outfile.replace(/\.tar\.br$/, ".tar");

  await createTar(targetFiles, tarPath);
  await compressBrotli(tarPath, outfile);

  return outfile;
}

/**
 * Create tar+gzip compressed bundle from target files
 */
export async function createTarGzip({
  outfile,
  targetFiles,
}: {
  targetFiles: { path: string; name: string }[];
  outfile: string;
}): Promise<string> {
  const tarPath = outfile.replace(/\.tar\.gz$/, ".tar");

  await createTar(targetFiles, tarPath);
  await compressGzip(tarPath, outfile);

  return outfile;
}
