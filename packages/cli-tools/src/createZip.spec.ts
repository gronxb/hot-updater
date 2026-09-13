import fs from "fs/promises";
import os from "os";
import path from "path";

import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createZipTargetFiles } from "./createZip";

const createdDirectories: string[] = [];

describe("createZipTargetFiles", () => {
  afterEach(async () => {
    vi.useRealTimers();
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

  it("creates identical bytes for snapshots created at different times", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-zip-time-"),
    );
    createdDirectories.push(directory);

    const sourcePath = path.join(directory, "source.txt");
    const firstArchivePath = path.join(directory, "first.zip");
    const secondArchivePath = path.join(directory, "second.zip");
    await fs.writeFile(sourcePath, "same snapshot");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    await createZipTargetFiles({
      outfile: firstArchivePath,
      targetFiles: [{ name: "nested/source.txt", path: sourcePath }],
    });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await createZipTargetFiles({
      outfile: secondArchivePath,
      targetFiles: [{ name: "nested/source.txt", path: sourcePath }],
    });

    await expect(fs.readFile(secondArchivePath)).resolves.toEqual(
      await fs.readFile(firstArchivePath),
    );
  });

  it("creates identical bytes regardless of target input order", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-zip-order-"),
    );
    createdDirectories.push(directory);

    const firstSourcePath = path.join(directory, "first.txt");
    const secondSourcePath = path.join(directory, "second.txt");
    const firstArchivePath = path.join(directory, "first.zip");
    const secondArchivePath = path.join(directory, "second.zip");
    await fs.writeFile(firstSourcePath, "first");
    await fs.writeFile(secondSourcePath, "second");
    const targets = [
      { name: "z/second.txt", path: secondSourcePath },
      { name: "A/first.txt", path: firstSourcePath },
    ];

    await createZipTargetFiles({
      outfile: firstArchivePath,
      targetFiles: targets,
    });
    await createZipTargetFiles({
      outfile: secondArchivePath,
      targetFiles: [...targets].reverse(),
    });

    await expect(fs.readFile(secondArchivePath)).resolves.toEqual(
      await fs.readFile(firstArchivePath),
    );
  });
});
