import fs from "fs/promises";
import os from "os";
import path from "path";

import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { createZip } from "./createZip";

const createdDirectories: string[] = [];

describe("createZip", () => {
  afterEach(async () => {
    await Promise.all(
      createdDirectories.map((directory) =>
        fs.rm(directory, { recursive: true, force: true }),
      ),
    );
    createdDirectories.length = 0;
  });

  it("creates a deterministic infrastructure archive from a directory", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-zip-"),
    );
    createdDirectories.push(directory);

    const sourceDirectory = path.join(directory, "lambda");
    const sourcePath = path.join(sourceDirectory, "index.js");
    const archivePath = path.join(directory, "lambda.zip");
    await fs.mkdir(sourceDirectory);
    await fs.writeFile(sourcePath, "bundle-content");

    await createZip({
      outfile: archivePath,
      targetDir: sourceDirectory,
    });

    const zip = await JSZip.loadAsync(await fs.readFile(archivePath));
    await expect(zip.file("index.js")?.async("string")).resolves.toBe(
      "bundle-content",
    );
  });
});
