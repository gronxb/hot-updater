import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertPathInside,
  resolveContainedPath,
  resolveContainedRegularPath,
} from "./pathBoundary";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-path-boundary-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("resolveContainedPath", () => {
  it("rejects a sibling path with the same prefix", () => {
    expect(() =>
      assertPathInside("/tmp/package", "/tmp/package-evil/index.mjs"),
    ).toThrow("escapes its allowed root");
  });

  it("resolves a path contained by its real root", async () => {
    const root = await createTemporaryDirectory();
    const entry = path.join(root, "dist", "index.mjs");
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, "export {};", "utf8");

    await expect(resolveContainedPath(root, entry)).resolves.toBe(
      await fs.realpath(entry),
    );
  });

  it("rejects parent traversal outside the root", async () => {
    const parent = await createTemporaryDirectory();
    const root = path.join(parent, "package");
    const outside = path.join(parent, "outside.mjs");
    await fs.mkdir(root);
    await fs.writeFile(outside, "export {};", "utf8");

    await expect(resolveContainedPath(root, outside)).rejects.toThrow(
      "escapes its allowed root",
    );
  });

  it("rejects a symlink that resolves outside the root", async () => {
    const parent = await createTemporaryDirectory();
    const root = path.join(parent, "package");
    const outside = path.join(parent, "outside.mjs");
    const link = path.join(root, "dist", "index.mjs");
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.writeFile(outside, "export {};", "utf8");
    await fs.symlink(outside, link);

    await expect(resolveContainedPath(root, link)).rejects.toThrow(
      "escapes its allowed root",
    );
  });

  it("rejects source symlinks that stay inside the root", async () => {
    const root = await createTemporaryDirectory();
    const entry = path.join(root, "dist", "entry.mjs");
    const link = path.join(root, "dist", "link.mjs");
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, "export {};", "utf8");
    await fs.symlink(entry, link);

    await expect(resolveContainedRegularPath(root, link)).rejects.toThrow(
      "must not contain symlinks",
    );
  });
});
