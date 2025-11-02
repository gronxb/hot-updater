import fs from "fs/promises";
import path from "path";
import * as tar from "tar";

export const createTarGzTargetFiles = async ({
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

    // Ensure output directory exists
    await fs.mkdir(path.dirname(outfile), { recursive: true });

    // Create tar.gz archive directly from temp directory
    await tar.create(
      {
        file: outfile,
        cwd: tmpDir,
        portable: true,
        mtime: new Date(0), // Set consistent timestamp for deterministic builds
        gzip: true, // Enable gzip compression
      },
      await fs.readdir(tmpDir),
    );

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

export const createTarGz = async ({
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

  // Create tar.gz archive
  await tar.create(
    {
      file: outfile,
      cwd: targetDir,
      portable: true,
      mtime: new Date(0), // Set consistent timestamp for deterministic builds
      gzip: true, // Enable gzip compression
    },
    filesToInclude,
  );

  return outfile;
};
