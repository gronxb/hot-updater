import path from "path";
import fs from "fs/promises";

import JSZip from "jszip";

export const createZip = async (dirPath: string, filename: string) => {
  const zip = new JSZip();
  await fs.rm(path.join(dirPath, filename), { force: true });

  async function addFiles(dir: string, zipFolder: JSZip) {
    const files = await fs.readdir(dir);
    files.sort();
    for (const file of files) {
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

  await addFiles(dirPath, zip);

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

  await fs.writeFile(filename, content);
};
