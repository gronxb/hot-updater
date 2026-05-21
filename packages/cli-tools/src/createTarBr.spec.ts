import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { brotliDecompress } from "zlib";

import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

import { createTarBrTargetFiles } from "./createTarBr";

const decompressBrotli = promisify(brotliDecompress);
const createdDirectories: string[] = [];

describe("createTarBrTargetFiles", () => {
  afterEach(async () => {
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
});
