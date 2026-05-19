import { createReadStream, createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";

import JSZip from "jszip";

export const createZipTargetFiles = async ({
  outfile,
  targetFiles,
}: {
  targetFiles: { path: string; name: string }[];
  outfile: string;
}) => {
  const zip = new JSZip();
  await fs.rm(outfile, { force: true });
  const zipFileOptions = { date: new Date(0) };

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
        zipFolder.file(file, createReadStream(fullPath), zipFileOptions);
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
      zip.file(target.name, createReadStream(target.path), zipFileOptions);
    }
  }

  await fs.mkdir(path.dirname(outfile), { recursive: true });
  await pipeline(
    zip.generateNodeStream({
      type: "nodebuffer",
      streamFiles: true,
      compression: "DEFLATE",
      compressionOptions: {
        level: 9,
      },
      platform: "UNIX",
    }),
    createWriteStream(outfile),
  );
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
  const zipFileOptions = { date: new Date(0) };

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
        zipFolder.file(file, createReadStream(fullPath), zipFileOptions);
      }
    }
  }

  await addFiles(targetDir, zip);

  await fs.mkdir(path.dirname(outfile), { recursive: true });
  await pipeline(
    zip.generateNodeStream({
      type: "nodebuffer",
      streamFiles: true,
      compression: "DEFLATE",
      compressionOptions: {
        level: 9,
      },
      platform: "UNIX",
    }),
    createWriteStream(outfile),
  );
  return outfile;
};
