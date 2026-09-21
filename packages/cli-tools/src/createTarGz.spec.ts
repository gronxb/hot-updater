import fs from "fs/promises";
import os from "os";
import path from "path";

import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTarGzTargetFiles } from "./createTarGz";

const createdDirectories: string[] = [];

describe("createTarGzTargetFiles", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      createdDirectories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
    createdDirectories.length = 0;
  });

  it("preserves a POSIX PAX path in a gzip-compressed TAR archive", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-tar-gz-"),
    );
    createdDirectories.push(directory);

    const sourcePath = path.join(directory, "asset.bmp");
    const archivePath = path.join(directory, "bundle.tar.gz");
    const extractPath = path.join(directory, "extract");
    const targetName = `assets/${"long-name-".repeat(14)}asset.bmp`;
    await fs.writeFile(sourcePath, "pax asset");

    await createTarGzTargetFiles({
      outfile: archivePath,
      targetFiles: [{ name: targetName, path: sourcePath }],
    });
    await fs.mkdir(extractPath, { recursive: true });
    await tar.extract({
      cwd: extractPath,
      file: archivePath,
      gzip: true,
    });

    await expect(
      fs.readFile(path.join(extractPath, targetName), "utf8"),
    ).resolves.toBe("pax asset");
  });

  it("creates identical bytes across enumeration orders and umasks", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-tar-gz-deterministic-"),
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

    const firstArchivePath = path.join(directory, "first.tar.gz");
    const secondArchivePath = path.join(directory, "second.tar.gz");
    const originalUmask = process.umask();

    try {
      process.umask(0o022);
      await createTarGzTargetFiles({
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
      await createTarGzTargetFiles({
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
