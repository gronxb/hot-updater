import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { createJiti } from "jiti";
import { afterEach, describe, expect, it } from "vitest";

import { virtualizeGeneratedSchemaImports } from "./generated-schema-virtual-module";

const temporaryDirectories = new Set<string>();
const jiti = createJiti(import.meta.url, {
  fsCache: false,
  moduleCache: true,
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

describe("generated schema virtual module transform", () => {
  afterEach(async () => {
    await Promise.all(
      [...temporaryDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    temporaryDirectories.clear();
  });

  it("does not transform a node_modules importer reached through a symlink", async () => {
    const projectDir = await createTemporaryDirectory(
      "hot-updater-node-modules-symlink-",
    );
    const packageDir = path.join(projectDir, "packages", "server");
    const importerPath = path.join(packageDir, "db.ts");
    const linkedPackageDir = path.join(projectDir, "node_modules", "server");
    const linkedImporterPath = path.join(linkedPackageDir, "db.ts");
    const source = 'const client = require("./generated/prisma");';
    await mkdir(packageDir, { recursive: true });
    await mkdir(path.dirname(linkedPackageDir), { recursive: true });
    await writeFile(importerPath, source);
    await symlink(
      packageDir,
      linkedPackageDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    const virtualModules: Record<string, unknown> = {};
    expect(
      virtualizeGeneratedSchemaImports(
        source,
        linkedImporterPath,
        projectDir,
        jiti,
        virtualModules,
        new Set(),
      ),
    ).toBe(source);
    expect(virtualModules).toEqual({});
  });

  it("does not transform an external node_modules symlink into the project", async () => {
    const testDir = await createTemporaryDirectory(
      "hot-updater-external-node-modules-symlink-",
    );
    const projectDir = path.join(testDir, "project");
    const packageDir = path.join(projectDir, "src");
    const importerPath = path.join(packageDir, "db.ts");
    const linkedPackageDir = path.join(testDir, "node_modules", "server");
    const linkedImporterPath = path.join(linkedPackageDir, "db.ts");
    const source = 'const client = require("./generated/prisma");';
    await mkdir(packageDir, { recursive: true });
    await mkdir(path.dirname(linkedPackageDir), { recursive: true });
    await writeFile(importerPath, source);
    await symlink(
      packageDir,
      linkedPackageDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    const virtualModules: Record<string, unknown> = {};
    expect(
      virtualizeGeneratedSchemaImports(
        source,
        linkedImporterPath,
        projectDir,
        jiti,
        virtualModules,
        new Set(),
      ),
    ).toBe(source);
    expect(virtualModules).toEqual({});
  });
});
