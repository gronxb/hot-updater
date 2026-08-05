import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { createJiti } from "jiti";
import { afterEach, describe, expect, it } from "vitest";

import { resolveGeneratedSchemaVirtualModule } from "./generated-schema-virtual-module";

const temporaryDirectories = new Set<string>();
const jiti = createJiti(import.meta.url, {
  fsCache: false,
  moduleCache: true,
});

const createTemporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
};

const resolveVirtualModule = (
  request: string,
  projectDir: string,
  importerPath: string,
) =>
  resolveGeneratedSchemaVirtualModule(request, importerPath, projectDir, jiti);

describe("generated schema virtual module", () => {
  afterEach(async () => {
    await Promise.all(
      [...temporaryDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    temporaryDirectories.clear();
  });

  it("rejects virtual imports outside the project directory", async () => {
    const testDir = await createTemporaryDirectory(
      "hot-updater-placeholder-outside-",
    );
    const projectDir = path.join(testDir, "project");
    const srcDir = path.join(projectDir, "src");
    await mkdir(srcDir, { recursive: true });
    const requestedPath = path.join(testDir, "hot-updater-schema");
    const importerPath = path.join(srcDir, "db.ts");
    await writeFile(importerPath, `import ${JSON.stringify(requestedPath)};`);
    expect(
      resolveVirtualModule(requestedPath, projectDir, importerPath),
    ).toBeUndefined();
  });

  it("accepts project-local absolute paths reported by the loader", async () => {
    const projectDir = await createTemporaryDirectory(
      "hot-updater-placeholder-path-",
    );
    const srcDir = path.join(projectDir, "src");
    await mkdir(srcDir);
    const requestedPath = path.join(projectDir, "hot-updater-schema");
    const importerPath = path.join(srcDir, "db.ts");
    await writeFile(importerPath, `import ${JSON.stringify(requestedPath)};`);
    expect(
      resolveVirtualModule(requestedPath, projectDir, importerPath),
    ).toBeDefined();
  });

  it("rejects bare module requests", async () => {
    const projectDir = await createTemporaryDirectory(
      "hot-updater-virtual-error-code-",
    );
    const importerPath = path.join(projectDir, "db.ts");
    await writeFile(importerPath, 'import "./generated/prisma";');
    expect(
      resolveVirtualModule("missing-package", projectDir, importerPath),
    ).toBeUndefined();
  });

  it.each([
    ".foo/generated/prisma",
    ".../generated/prisma",
    ".foo/hot-updater-schema",
  ])("rejects the dot-prefixed bare request %s", async (request) => {
    const projectDir = await createTemporaryDirectory(
      "hot-updater-dot-prefixed-request-",
    );
    const importerPath = path.join(projectDir, "db.ts");
    await writeFile(importerPath, `import ${JSON.stringify(request)};`);

    expect(
      resolveVirtualModule(request, projectDir, importerPath),
    ).toBeUndefined();
  });

  it.each([
    "./node_modules/pkg/generated/prisma",
    "./NODE_MODULES/pkg/generated/prisma",
  ])("rejects the dependency target %s", async (request) => {
    const projectDir = await createTemporaryDirectory(
      "hot-updater-dependency-target-",
    );
    const importerPath = path.join(projectDir, "db.ts");
    await writeFile(importerPath, `import ${JSON.stringify(request)};`);

    expect(
      resolveVirtualModule(request, projectDir, importerPath),
    ).toBeUndefined();
  });

  it("rejects unrelated missing local modules", async () => {
    const projectDir = await createTemporaryDirectory(
      "hot-updater-unrelated-module-",
    );
    const importerPath = path.join(projectDir, "db.ts");
    await writeFile(importerPath, 'import "./missing-helper";');

    expect(
      resolveVirtualModule("./missing-helper", projectDir, importerPath),
    ).toBeUndefined();
  });

  it.each([
    "prisma.ts",
    "prisma.js",
    "prisma.json",
    "prisma.node",
    path.join("prisma", "index.ts"),
  ])("rejects an existing generated/%s target", async (targetPath) => {
    const projectDir = await createTemporaryDirectory(
      "hot-updater-virtual-existing-target-",
    );
    const generatedDir = path.join(projectDir, "generated");
    const importerPath = path.join(projectDir, "db.ts");
    const existingTarget = path.join(generatedDir, targetPath);
    await mkdir(path.dirname(existingTarget), { recursive: true });
    await writeFile(importerPath, 'import "./generated/prisma";');
    await writeFile(existingTarget, "export {};");

    expect(
      resolveVirtualModule("./generated/prisma", projectDir, importerPath),
    ).toBeUndefined();
  });

  it("allows an empty directory at the generated module path", async () => {
    const projectDir = await createTemporaryDirectory(
      "hot-updater-virtual-empty-target-",
    );
    const importerPath = path.join(projectDir, "db.ts");
    await mkdir(path.join(projectDir, "generated", "prisma"), {
      recursive: true,
    });
    await writeFile(importerPath, 'import "./generated/prisma";');

    expect(
      resolveVirtualModule("./generated/prisma", projectDir, importerPath),
    ).toBeDefined();
  });

  it("rejects a missing path below a symlink outside the project", async () => {
    const testDir = await createTemporaryDirectory(
      "hot-updater-placeholder-symlink-",
    );
    const projectDir = path.join(testDir, "project");
    const outsideDir = path.join(testDir, "outside");
    const srcDir = path.join(projectDir, "src");
    await mkdir(srcDir, { recursive: true });
    await mkdir(outsideDir);
    const aliasPath = path.join(projectDir, "alias");
    await symlink(
      outsideDir,
      aliasPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    const requestedPath = path.join(aliasPath, "generated", "prisma");
    const importerPath = path.join(srcDir, "db.ts");
    await writeFile(importerPath, `import ${JSON.stringify(requestedPath)};`);
    expect(
      resolveVirtualModule(requestedPath, projectDir, importerPath),
    ).toBeUndefined();
  });

  it("rejects an aliased target inside node_modules", async () => {
    const projectDir = await createTemporaryDirectory(
      "hot-updater-dependency-target-symlink-",
    );
    const importerPath = path.join(projectDir, "db.ts");
    const dependencyDir = path.join(projectDir, "node_modules", "pkg");
    await mkdir(dependencyDir, { recursive: true });
    await symlink(
      dependencyDir,
      path.join(projectDir, "vendor"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(importerPath, 'import "./vendor/generated/prisma";');

    expect(
      resolveVirtualModule(
        "./vendor/generated/prisma",
        projectDir,
        importerPath,
      ),
    ).toBeUndefined();
  });

  it.each(["directory", "target"])(
    "rejects a missing path below a dangling outward %s symlink",
    async (layout) => {
      const testDir = await createTemporaryDirectory(
        "hot-updater-placeholder-dangling-symlink-",
      );
      const projectDir = path.join(testDir, "project");
      const srcDir = path.join(projectDir, "src");
      await mkdir(srcDir, { recursive: true });
      const generatedDir = path.join(projectDir, "generated");
      if (layout === "target") await mkdir(generatedDir);
      const aliasPath =
        layout === "directory"
          ? generatedDir
          : path.join(generatedDir, "prisma");
      await symlink(
        path.join(testDir, "outside", "not-created"),
        aliasPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      const importerPath = path.join(srcDir, "db.ts");
      await writeFile(importerPath, 'import "../generated/prisma";');

      expect(
        resolveVirtualModule("../generated/prisma", projectDir, importerPath),
      ).toBeUndefined();
    },
  );
});
