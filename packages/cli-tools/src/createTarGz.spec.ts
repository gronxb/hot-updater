import fs from "fs/promises";
import os from "os";
import path from "path";

import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

import { createTarGzTargetFiles } from "./createTarGz";

const createdDirectories: string[] = [];

describe("createTarGzTargetFiles", () => {
  afterEach(async () => {
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
});
