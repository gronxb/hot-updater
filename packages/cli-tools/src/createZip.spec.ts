import fs from "fs/promises";
import os from "os";
import path from "path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { createZipTargetFiles } from "./createZip";

const createdDirectories: string[] = [];

describe("createZipTargetFiles", () => {
  afterEach(async () => {
    await Promise.all(
      createdDirectories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
    createdDirectories.length = 0;
  });

  it("creates a zip archive from target files", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-zip-"),
    );
    createdDirectories.push(directory);

    const sourcePath = path.join(directory, "index.android.bundle");
    const archivePath = path.join(directory, "bundle.zip");
    await fs.writeFile(sourcePath, "bundle-content");

    await createZipTargetFiles({
      outfile: archivePath,
      targetFiles: [
        {
          path: sourcePath,
          name: "nested/index.android.bundle",
        },
      ],
    });

    const zip = await JSZip.loadAsync(await fs.readFile(archivePath));
    await expect(
      zip.file("nested/index.android.bundle")?.async("string"),
    ).resolves.toBe("bundle-content");
  });
});
