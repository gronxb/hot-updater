import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const testRoot = vi.hoisted(() => ({ path: "" }));

vi.mock("./cwd", () => ({
  getCwd: () => testRoot.path,
}));

import { copyDirToTmp } from "./copyDirToTmp";

const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdDirectories.map((directory) =>
      fs.rm(directory, { force: true, recursive: true }),
    ),
  );
  createdDirectories.length = 0;
});

it("isolates concurrent copies and cleans up only the owned directory", async () => {
  testRoot.path = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-copy-root-"),
  );
  const firstSource = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-copy-first-"),
  );
  const secondSource = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-copy-second-"),
  );
  createdDirectories.push(testRoot.path, firstSource, secondSource);
  await fs.writeFile(path.join(firstSource, "value.txt"), "first");
  await fs.writeFile(path.join(secondSource, "value.txt"), "second");

  const [first, second] = await Promise.all([
    copyDirToTmp(firstSource),
    copyDirToTmp(secondSource),
  ]);

  expect(first.tmpDir).not.toBe(second.tmpDir);
  await expect(
    fs.readFile(path.join(first.tmpDir, "value.txt"), "utf8"),
  ).resolves.toBe("first");
  await expect(
    fs.readFile(path.join(second.tmpDir, "value.txt"), "utf8"),
  ).resolves.toBe("second");

  await first.removeTmpDir();

  await expect(fs.access(first.tmpDir)).rejects.toThrow();
  await expect(
    fs.readFile(path.join(second.tmpDir, "value.txt"), "utf8"),
  ).resolves.toBe("second");
  await second.removeTmpDir();
});
