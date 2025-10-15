import fs from "fs/promises";
import { createBrotliCompress, constants as zlibConstants } from "zlib";
import { pipeline } from "stream/promises";
import path from "path";
import { create as createTar } from "tar";

export const createTarBrotliTargetFiles = async ({
  outfile,
  targetFiles,
}: {
  targetFiles: { path: string; name: string }[];
  outfile: string;
}) => {
  await fs.rm(outfile, { force: true });
  await fs.mkdir(path.dirname(outfile), { recursive: true });

  // Sort files for deterministic output
  const sortedFiles = [...targetFiles].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // Create tar stream
  const tarStream = createTar(
    {
      gzip: false,
      portable: true,
      // Set deterministic mtime for consistent hashing
      mtime: new Date(0),
    },
    sortedFiles.map((file) => file.path),
  );

  // Create brotli compression stream with high quality
  const brotliStream = createBrotliCompress({
    params: {
      // Quality level 9 for maximum compression
      [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
      // Use text mode for better compression of JS/JSON files
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
    },
  });

  // Create output file stream
  const outputStream = await fs.open(outfile, "w");

  try {
    // Pipeline: tar -> brotli -> file
    await pipeline(tarStream, brotliStream, outputStream.createWriteStream());
  } finally {
    await outputStream.close();
  }

  return outfile;
};

export const createTarBrotli = async ({
  outfile,
  targetDir,
  excludeExts = [],
}: {
  targetDir: string;
  outfile: string;
  excludeExts?: string[];
}) => {
  await fs.rm(outfile, { force: true });
  await fs.mkdir(path.dirname(outfile), { recursive: true });

  // Collect all files recursively
  const files: string[] = [];

  async function collectFiles(dir: string, basePath: string = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    // Sort for deterministic output
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      // Check if file should be excluded
      if (excludeExts.some((pattern) => entry.name.includes(pattern))) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(basePath, entry.name);

      if (entry.isDirectory()) {
        await collectFiles(fullPath, relativePath);
      } else {
        files.push(fullPath);
      }
    }
  }

  await collectFiles(targetDir);

  // Create tar stream with collected files
  const tarStream = createTar(
    {
      gzip: false,
      portable: true,
      cwd: targetDir,
      // Set deterministic mtime for consistent hashing
      mtime: new Date(0),
      // Use relative paths from targetDir
      filter: (filePath) => {
        const relativePath = path.relative(targetDir, filePath);
        return !excludeExts.some((pattern) => relativePath.includes(pattern));
      },
    },
    files.map((file) => path.relative(targetDir, file)),
  );

  // Create brotli compression stream with high quality
  const brotliStream = createBrotliCompress({
    params: {
      // Quality level 9 for maximum compression
      [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
      // Use text mode for better compression of JS/JSON files
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
    },
  });

  // Create output file stream
  const outputStream = await fs.open(outfile, "w");

  try {
    // Pipeline: tar -> brotli -> file
    await pipeline(tarStream, brotliStream, outputStream.createWriteStream());
  } finally {
    await outputStream.close();
  }

  return outfile;
};
