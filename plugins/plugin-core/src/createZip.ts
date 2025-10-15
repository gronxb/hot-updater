import type { CompressionStrategy } from "@hot-updater/core";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import JSZip from "jszip";
import path from "path";
import { pipeline } from "stream/promises";
import tar from "tar-stream";
import { createBrotliCompress, createGzip } from "zlib";

export const createZipTargetFiles = async ({
  outfile,
  targetFiles,
}: {
  targetFiles: { path: string; name: string }[];
  outfile: string;
}) => {
  const zip = new JSZip();
  await fs.rm(outfile, { force: true });

  async function addFiles(dir: string, zipFolder: JSZip) {
    const files = await fs.readdir(dir);
    files.sort();

    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stats = await fs.stat(fullPath);

      if (stats.isDirectory()) {
        const folder = zipFolder.folder(file);
        if (!folder) continue;
        await addFiles(fullPath, folder);
      } else {
        const data = await fs.readFile(fullPath);
        zipFolder.file(file, data);
      }
    }
  }

  for (const target of targetFiles) {
    const stats = await fs.stat(target.path);
    if (stats.isDirectory()) {
      const folder = zip.folder(target.name);
      if (folder) {
        await addFiles(target.path, folder);
      }
    } else {
      const data = await fs.readFile(target.path);
      zip.file(target.name, data);
    }
  }

  const content = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: {
      level: 9,
    },
    platform: "UNIX",
  });

  await fs.mkdir(path.dirname(outfile), { recursive: true });
  await fs.writeFile(outfile, content);
  return outfile;
};

export const createZip = async ({
  outfile,
  targetDir,
  excludeExts = [],
}: {
  targetDir: string;
  outfile: string;
  excludeExts?: string[];
}) => {
  const zip = new JSZip();
  await fs.rm(outfile, { force: true });

  async function addFiles(dir: string, zipFolder: JSZip) {
    const files = await fs.readdir(dir);
    files.sort();

    for (const file of files) {
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
  }

  await addFiles(targetDir, zip);

  // fix hash
  zip.forEach((_, file) => {
    file.date = new Date(0);
  });

  const content = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: {
      level: 9,
    },
    platform: "UNIX",
  });

  await fs.writeFile(outfile, content);
  return outfile;
};

/**
 * Creates a tar archive with specified compression
 */
const createTarArchive = async ({
  outfile,
  targetFiles,
  compressionStream,
}: {
  targetFiles: { path: string; name: string }[];
  outfile: string;
  compressionStream: NodeJS.WritableStream;
}): Promise<string> => {
  const pack = tar.pack();

  await fs.rm(outfile, { force: true });
  await fs.mkdir(path.dirname(outfile), { recursive: true });

  const writeStream = createWriteStream(outfile);

  // Pipe: pack -> compression -> file
  const pipelinePromise = pipeline(pack, compressionStream, writeStream);

  // Add files recursively to the tar archive
  async function addFilesToTar(
    filePath: string,
    archiveName: string,
  ): Promise<void> {
    const stats = await fs.stat(filePath);

    if (stats.isDirectory()) {
      const files = await fs.readdir(filePath);
      files.sort();

      for (const file of files) {
        const fullPath = path.join(filePath, file);
        const archivePath = path.join(archiveName, file);
        await addFilesToTar(fullPath, archivePath);
      }
    } else {
      const data = await fs.readFile(filePath);
      pack.entry(
        {
          name: archiveName,
          size: data.length,
          mode: stats.mode,
          mtime: new Date(0), // Fix hash by using consistent timestamp
        },
        data,
      );
    }
  }

  // Add all target files
  for (const target of targetFiles) {
    await addFilesToTar(target.path, target.name);
  }

  pack.finalize();
  await pipelinePromise;

  return outfile;
};

/**
 * Creates a tar.gz (gzip) archive
 */
export const createTarGzipTargetFiles = async ({
  outfile,
  targetFiles,
}: {
  targetFiles: { path: string; name: string }[];
  outfile: string;
}): Promise<string> => {
  return createTarArchive({
    outfile,
    targetFiles,
    compressionStream: createGzip({ level: 9 }),
  });
};

/**
 * Creates a tar.br (brotli) archive
 */
export const createTarBrotliTargetFiles = async ({
  outfile,
  targetFiles,
}: {
  targetFiles: { path: string; name: string }[];
  outfile: string;
}): Promise<string> => {
  return createTarArchive({
    outfile,
    targetFiles,
    compressionStream: createBrotliCompress({
      params: {
        // @ts-expect-error - Node.js zlib constants
        [require("zlib").constants.BROTLI_PARAM_QUALITY]: 11, // Max quality
      },
    }),
  });
};

/**
 * Creates a compressed bundle based on the compression strategy
 */
export const createBundleArchive = async ({
  outfile,
  targetFiles,
  compressionStrategy = "zip",
}: {
  targetFiles: { path: string; name: string }[];
  outfile: string;
  compressionStrategy?: CompressionStrategy;
}): Promise<string> => {
  switch (compressionStrategy) {
    case "tarGzip":
      return createTarGzipTargetFiles({ outfile, targetFiles });
    case "tarBrotli":
      return createTarBrotliTargetFiles({ outfile, targetFiles });
    default:
      return createZipTargetFiles({ outfile, targetFiles });
  }
};
