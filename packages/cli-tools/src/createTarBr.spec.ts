import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { brotliDecompress } from "zlib";

import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTarBrTargetFiles } from "./createTarBr";

const decompressBrotli = promisify(brotliDecompress);
const createdDirectories: string[] = [];

describe("createTarBrTargetFiles", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      createdDirectories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
    createdDirectories.length = 0;
  });

  it("creates a brotli-compressed tar archive from target files", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-tar-br-"),
    );
    createdDirectories.push(directory);

    const sourcePath = path.join(directory, "index.android.bundle");
    const archivePath = path.join(directory, "bundle.tar.br");
    const tarPath = path.join(directory, "bundle.tar");
    const extractPath = path.join(directory, "extract");

    await fs.writeFile(sourcePath, "bundle-content");

    await createTarBrTargetFiles({
      outfile: archivePath,
      targetFiles: [
        {
          path: sourcePath,
          name: "nested/index.android.bundle",
        },
      ],
    });

    await fs.writeFile(
      tarPath,
      await decompressBrotli(await fs.readFile(archivePath)),
    );
    await fs.mkdir(extractPath, { recursive: true });
    await tar.extract({
      file: tarPath,
      cwd: extractPath,
    });

    await expect(
      fs.readFile(
        path.join(extractPath, "nested/index.android.bundle"),
        "utf8",
      ),
    ).resolves.toBe("bundle-content");
  });

  it("creates identical bytes across enumeration orders and umasks", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-tar-br-deterministic-"),
    );
    createdDirectories.push(directory);

    const sourcePath = path.join(directory, "source");
    await fs.mkdir(path.join(sourcePath, "z-dir"), { recursive: true });
    await fs.mkdir(path.join(sourcePath, "A-dir", "empty"), {
      recursive: true,
    });
    await fs.writeFile(path.join(sourcePath, "z-dir", "b.txt"), "b");
    await fs.writeFile(path.join(sourcePath, "A-dir", "a.txt"), "a");
    const standalonePath = path.join(directory, "standalone.txt");
    await fs.writeFile(standalonePath, "standalone");
    const targetFiles = [
      { name: "payload", path: sourcePath },
      { name: "standalone.txt", path: standalonePath },
    ];

    const firstArchivePath = path.join(directory, "first.tar.br");
    const secondArchivePath = path.join(directory, "second.tar.br");
    const originalUmask = process.umask();

    try {
      process.umask(0o022);
      await createTarBrTargetFiles({
        outfile: firstArchivePath,
        targetFiles,
      });

      const originalReaddir = fs.readdir.bind(fs);
      vi.spyOn(fs, "readdir").mockImplementation((async (
        ...args: Parameters<typeof fs.readdir>
      ) => {
        const entries = await originalReaddir(...args);
        return entries.reverse();
      }) as typeof fs.readdir);
      process.umask(0o077);
      await createTarBrTargetFiles({
        outfile: secondArchivePath,
        targetFiles,
      });
    } finally {
      process.umask(originalUmask);
    }

    await expect(fs.readFile(secondArchivePath)).resolves.toEqual(
      await fs.readFile(firstArchivePath),
    );
  });
});
