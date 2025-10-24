import { createBrotliCompress } from "node:zlib";
import fs from "fs/promises";
import path from "path";
import { pack } from "tar-stream";

export const createTarBrTargetFiles = async ({
  outfile,
  targetFiles,
}: {
  targetFiles: { path: string; name: string }[];
  outfile: string;
}): Promise<string> => {
  const tarPack = pack();
  await fs.rm(outfile, { force: true });

  async function addFiles(dir: string, tarPath: string) {
    const files = await fs.readdir(dir);
    files.sort();

    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stats = await fs.stat(fullPath);
      const entryPath = path.join(tarPath, file);

      if (stats.isDirectory()) {
        await addFiles(fullPath, entryPath);
      } else {
        const data = await fs.readFile(fullPath);
        tarPack.entry(
          {
            name: entryPath,
            size: stats.size,
            mode: stats.mode,
            mtime: new Date(0), // fix hash - use epoch time
          },
          data,
        );
      }
    }
  }

  // Add all target files to tar
  for (const target of targetFiles) {
    const stats = await fs.stat(target.path);
    if (stats.isDirectory()) {
      await addFiles(target.path, target.name);
    } else {
      const data = await fs.readFile(target.path);
      tarPack.entry(
        {
          name: target.name,
          size: stats.size,
          mode: stats.mode,
          mtime: new Date(0), // fix hash - use epoch time
        },
        data,
      );
    }
  }

  // Finalize tar stream
  tarPack.finalize();

  // Create brotli compress stream
  const brotli = createBrotliCompress({
    params: {
      [9]: 11, // BROTLI_PARAM_QUALITY - maximum compression (0-11)
    },
  });

  // Pipe tar through brotli to file
  await fs.mkdir(path.dirname(outfile), { recursive: true });
  const writeStream = await fs.open(outfile, "w");

  return new Promise((resolve, reject) => {
    const fileStream = writeStream.createWriteStream();

    tarPack.pipe(brotli).pipe(fileStream);

    fileStream.on("finish", async () => {
      await writeStream.close();
      resolve(outfile);
    });

    fileStream.on("error", async (error) => {
      await writeStream.close();
      reject(error);
    });

    brotli.on("error", reject);
    tarPack.on("error", reject);
  });
};

export const createTarBr = async ({
  outfile,
  targetDir,
  excludeExts = [],
}: {
  targetDir: string;
  outfile: string;
  excludeExts?: string[];
}): Promise<string> => {
  const tarPack = pack();
  await fs.rm(outfile, { force: true });

  async function addFiles(dir: string, tarPath: string) {
    const files = await fs.readdir(dir);
    files.sort();

    for (const file of files) {
      if (excludeExts.some((pattern) => file.includes(pattern))) {
        continue;
      }

      const fullPath = path.join(dir, file);
      const stats = await fs.stat(fullPath);
      const entryPath = tarPath ? path.join(tarPath, file) : file;

      if (stats.isDirectory()) {
        await addFiles(fullPath, entryPath);
      } else {
        const data = await fs.readFile(fullPath);
        tarPack.entry(
          {
            name: entryPath,
            size: stats.size,
            mode: stats.mode,
            mtime: new Date(0), // fix hash - use epoch time
          },
          data,
        );
      }
    }
  }

  await addFiles(targetDir, "");

  // Finalize tar stream
  tarPack.finalize();

  // Create brotli compress stream
  const brotli = createBrotliCompress({
    params: {
      [9]: 11, // BROTLI_PARAM_QUALITY - maximum compression (0-11)
    },
  });

  // Pipe tar through brotli to file
  await fs.mkdir(path.dirname(outfile), { recursive: true });
  const writeStream = await fs.open(outfile, "w");

  return new Promise((resolve, reject) => {
    const fileStream = writeStream.createWriteStream();

    tarPack.pipe(brotli).pipe(fileStream);

    fileStream.on("finish", async () => {
      await writeStream.close();
      resolve(outfile);
    });

    fileStream.on("error", async (error) => {
      await writeStream.close();
      reject(error);
    });

    brotli.on("error", reject);
    tarPack.on("error", reject);
  });
};
