import fs from "fs/promises";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import path from "path";
import { create as createTar } from "tar";

export const createTarGzipTargetFiles = async ({
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

  // Create gzip compression stream with maximum compression
  const gzipStream = createGzip({
    level: 9, // Maximum compression level
  });

  // Create output file stream
  const outputStream = await fs.open(outfile, "w");

  try {
    // Pipeline: tar -> gzip -> file
    await pipeline(tarStream, gzipStream, outputStream.createWriteStream());
  } finally {
    await outputStream.close();
  }

  return outfile;
};

export const createTarGzip = async ({
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

  // Create gzip compression stream with maximum compression
  const gzipStream = createGzip({
    level: 9, // Maximum compression level
  });

  // Create output file stream
  const outputStream = await fs.open(outfile, "w");

  try {
    // Pipeline: tar -> gzip -> file
    await pipeline(tarStream, gzipStream, outputStream.createWriteStream());
  } finally {
    await outputStream.close();
  }

  return outfile;
};
