import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectBareImportSpecifiers } from "./packageImports";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

async function createPackageRoot(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-package-imports-"),
  );
  temporaryDirectories.push(directory);
  const packageRoot = path.join(directory, "package");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  return packageRoot;
}

describe("collectBareImportSpecifiers", () => {
  it("collects bare imports through contained relative modules", async () => {
    const packageRoot = await createPackageRoot();
    const entry = path.join(packageRoot, "dist", "index.mjs");
    await fs.writeFile(entry, 'import "./nested.mjs";', "utf8");
    await fs.writeFile(
      path.join(packageRoot, "dist", "nested.mjs"),
      'import "mime";',
      "utf8",
    );

    await expect(
      collectBareImportSpecifiers(packageRoot, entry),
    ).resolves.toEqual(new Set(["mime"]));
  });

  it("rejects a relative import that traverses outside the package", async () => {
    const packageRoot = await createPackageRoot();
    const entry = path.join(packageRoot, "dist", "index.mjs");
    const outside = path.join(path.dirname(packageRoot), "outside.mjs");
    await fs.writeFile(entry, 'import "../../outside.mjs";', "utf8");
    await fs.writeFile(outside, "export {};", "utf8");

    await expect(
      collectBareImportSpecifiers(packageRoot, entry),
    ).rejects.toThrow("escapes its allowed root");
  });

  it("rejects a relative import through a source symlink", async () => {
    const packageRoot = await createPackageRoot();
    const entry = path.join(packageRoot, "dist", "index.mjs");
    const source = path.join(packageRoot, "dist", "source.mjs");
    const link = path.join(packageRoot, "dist", "linked.mjs");
    await fs.writeFile(entry, 'import "./linked.mjs";', "utf8");
    await fs.writeFile(source, "export {};", "utf8");
    await fs.symlink(source, link);

    await expect(
      collectBareImportSpecifiers(packageRoot, entry),
    ).rejects.toThrow("must not contain symlinks");
  });
});
