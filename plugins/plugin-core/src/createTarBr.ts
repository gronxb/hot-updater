import fs from "fs/promises";
import path from "path";
import * as tar from "tar";
import { brotliCompressSync, constants as zlibConstants } from "zlib";

export const createTarBrTargetFiles = async ({
  outfile,
  targetFiles,
}: {
  targetFiles: { path: string; name: string }[];
  outfile: string;
}) => {
  // Remove existing output file
  await fs.rm(outfile, { force: true });

  // Create a temporary directory to stage files with correct names
  const tmpDir = path.join(path.dirname(outfile), `.tmp-tar-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    // Copy files to temp directory with target names
    for (const target of targetFiles) {
      const sourcePath = target.path;
      const destPath = path.join(tmpDir, target.name);

      // Create parent directories if needed
      await fs.mkdir(path.dirname(destPath), { recursive: true });

      // Copy the file or directory
      const stats = await fs.stat(sourcePath);
      if (stats.isDirectory()) {
        // Copy directory recursively
        await copyDir(sourcePath, destPath);
      } else {
        await fs.copyFile(sourcePath, destPath);
      }
    }

    // Create a temporary tar file path
    const tmpTarFile = outfile.replace(/\.tar\.br$/, ".tar");

    // Create tar archive from temp directory
    await tar.create(
      {
        file: tmpTarFile,
        cwd: tmpDir,
        portable: true,
        mtime: new Date(0), // Set consistent timestamp for deterministic builds
        gzip: false,
      },
      await fs.readdir(tmpDir),
    );

    // Read the tar file
    const tarData = await fs.readFile(tmpTarFile);

    // Compress with Brotli at maximum compression level
    const compressedData = brotliCompressSync(tarData, {
      params: {
        // Use maximum compression level (11)
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        // Use large window size for better compression
        [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
      },
    });

    // Ensure output directory exists
    await fs.mkdir(path.dirname(outfile), { recursive: true });

    // Write the compressed file
    await fs.writeFile(outfile, compressedData);

    // Clean up temporary tar file
    await fs.rm(tmpTarFile, { force: true });

    return outfile;
  } finally {
    // Clean up temporary directory
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
};

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

export const createTarBr = async ({
  outfile,
  targetDir,
  excludeExts = [],
}: {
  targetDir: string;
  outfile: string;
  excludeExts?: string[];
}) => {
  // Remove existing output file
  await fs.rm(outfile, { force: true });

  // Create a temporary tar file path
  const tmpTarFile = outfile.replace(/\.tar\.br$/, ".tar");

  // Get all files from target directory
  async function getFiles(
    dir: string,
    baseDir: string = "",
  ): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      // Check exclusions
      if (excludeExts.some((pattern) => entry.name.includes(pattern))) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(baseDir, entry.name);

      if (entry.isDirectory()) {
        const subFiles = await getFiles(fullPath, relativePath);
        files.push(...subFiles);
      } else {
        files.push(relativePath);
      }
    }

    return files;
  }

  const filesToInclude = await getFiles(targetDir);
  filesToInclude.sort(); // Sort for deterministic output

  // Create tar archive
  await tar.create(
    {
      file: tmpTarFile,
      cwd: targetDir,
      portable: true,
      mtime: new Date(0), // Set consistent timestamp for deterministic builds
      gzip: false,
    },
    filesToInclude,
  );

  // Read the tar file
  const tarData = await fs.readFile(tmpTarFile);

  // Compress with Brotli at maximum compression level
  const compressedData = brotliCompressSync(tarData, {
    params: {
      // Use maximum compression level (11)
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      // Use large window size for better compression
      [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
    },
  });

  // Write the compressed file
  await fs.writeFile(outfile, compressedData);

  // Clean up temporary tar file
  await fs.rm(tmpTarFile, { force: true });

  return outfile;
};
