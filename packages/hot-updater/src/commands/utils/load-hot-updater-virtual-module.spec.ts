import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { describe, expect, it, vi } from "vitest";

import { loadHotUpdater } from "./load-hot-updater";

vi.mock("@hot-updater/cli-tools", () => ({
  p: {
    log: {
      error: vi.fn(),
      info: vi.fn(),
      message: vi.fn(),
    },
  },
}));

describe("generated schema virtual module", () => {
  it("virtualizes only the importer that reported the missing module", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-scoped-virtual-module-"),
    );
    const missingDir = path.join(projectDir, "src", "missing");
    const existingDir = path.join(projectDir, "src", "existing");
    await mkdir(path.join(existingDir, "generated"), { recursive: true });
    await mkdir(missingDir, { recursive: true });
    await writeFile(
      path.join(missingDir, "client.ts"),
      [
        'import { PrismaClient } from "./generated/prisma";',
        'export const requestLabel = "./generated/prisma";',
        "export const clientName = new PrismaClient().constructor.name;",
      ].join("\n"),
    );
    await writeFile(
      path.join(existingDir, "generated", "prisma.ts"),
      'export const source = "real";',
    );
    await writeFile(
      path.join(existingDir, "client.ts"),
      [
        'import { source } from "./generated/prisma";',
        "export { source };",
      ].join("\n"),
    );
    await writeFile(
      path.join(projectDir, "src", "db.ts"),
      [
        'import { clientName, requestLabel } from "./missing/client";',
        'import { source } from "./existing/client";',
        "export const hotUpdater = {",
        "  adapterName: `${clientName}:${source}:${requestLabel}`",
        "};",
      ].join("\n"),
    );

    try {
      const loaded = await loadHotUpdater("src/db.ts", {
        cwd: projectDir,
        allowGeneratedSchemaVirtualModule: true,
      });

      expect(loaded.adapterName).toBe("PrismaClient:real:./generated/prisma");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it.each(["direct", "transitive"])(
    "loads the generated client on a later %s config load",
    async (layout) => {
      const projectDir = await mkdtemp(
        path.join(tmpdir(), "hot-updater-virtual-module-cache-"),
      );
      const srcDir = path.join(projectDir, "src");
      const generatedDir = path.join(srcDir, "generated");
      await mkdir(srcDir, { recursive: true });
      if (layout === "transitive") {
        await writeFile(
          path.join(srcDir, "prisma.ts"),
          [
            'import { PrismaClient } from "./generated/prisma";',
            "export const prisma = new PrismaClient();",
          ].join("\n"),
        );
      }
      await writeFile(
        path.join(srcDir, "db.ts"),
        [
          layout === "direct"
            ? 'import { PrismaClient } from "./generated/prisma";'
            : 'import { prisma } from "./prisma";',
          ...(layout === "direct"
            ? ["const prisma = new PrismaClient();"]
            : []),
          "export const hotUpdater = {",
          "  adapterName: prisma.constructor.name,",
          "};",
          "export const closeDatabase = () => prisma.$disconnect();",
        ].join("\n"),
      );

      try {
        const initialLoad = await loadHotUpdater("src/db.ts", {
          cwd: projectDir,
          allowGeneratedSchemaVirtualModule: true,
        });
        expect(initialLoad.adapterName).toBe("PrismaClient");
        await initialLoad.dispose();

        await mkdir(generatedDir);
        await writeFile(
          path.join(generatedDir, "prisma.ts"),
          [
            "export class GeneratedPrismaClient {",
            "  async $disconnect() {}",
            "}",
            "export { GeneratedPrismaClient as PrismaClient };",
          ].join("\n"),
        );
        const generatedLoad = await loadHotUpdater("src/db.ts", {
          cwd: projectDir,
          allowGeneratedSchemaVirtualModule: true,
        });
        expect(generatedLoad.adapterName).toBe("GeneratedPrismaClient");
        await generatedLoad.dispose();
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    },
  );

  it("loads the generated client through a later sibling import", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-virtual-module-branch-"),
    );
    const srcDir = path.join(projectDir, "src");
    const generatedDir = path.join(srcDir, "generated");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "a.ts"),
      [
        'import { PrismaClient } from "./generated/prisma";',
        "export const source = new PrismaClient().constructor.name;",
      ].join("\n"),
    );
    await writeFile(
      path.join(srcDir, "b.ts"),
      [
        'import { source } from "./a";',
        "export const siblingSource = source;",
      ].join("\n"),
    );
    await writeFile(
      path.join(srcDir, "db.ts"),
      [
        'import { source } from "./a";',
        'import { siblingSource } from "./b";',
        "export const hotUpdater = {",
        "  adapterName: `${source}:${siblingSource}`",
        "};",
      ].join("\n"),
    );

    try {
      const initialLoad = await loadHotUpdater("src/db.ts", {
        cwd: projectDir,
        allowGeneratedSchemaVirtualModule: true,
      });
      expect(initialLoad.adapterName).toBe("PrismaClient:PrismaClient");
      await initialLoad.dispose();

      await mkdir(generatedDir);
      await writeFile(
        path.join(generatedDir, "prisma.ts"),
        [
          "export class GeneratedPrismaClient {",
          "  async $disconnect() {}",
          "}",
          "export { GeneratedPrismaClient as PrismaClient };",
        ].join("\n"),
      );
      const generatedLoad = await loadHotUpdater("src/db.ts", {
        cwd: projectDir,
        allowGeneratedSchemaVirtualModule: true,
      });
      expect(generatedLoad.adapterName).toBe(
        "GeneratedPrismaClient:GeneratedPrismaClient",
      );
      await generatedLoad.dispose();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("evaluates config side effects once while virtualizing", async () => {
    vi.stubEnv("JITI_MODULE_CACHE", "0");
    vi.stubEnv("JITI_REQUIRE_CACHE", "0");
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-virtual-module-side-effect-"),
    );
    const srcDir = path.join(projectDir, "src");
    const effectPath = path.join(projectDir, "effect.txt");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "effect.ts"),
      [
        'import { appendFileSync } from "fs";',
        `appendFileSync(${JSON.stringify(effectPath)}, "x");`,
      ].join("\n"),
    );
    await writeFile(
      path.join(srcDir, "db.ts"),
      [
        'import "./effect";',
        'import { PrismaClient } from "./generated/prisma";',
        "const prisma = new PrismaClient();",
        'export const hotUpdater = { adapterName: "prisma" };',
        "export const closeDatabase = () => prisma.$disconnect();",
      ].join("\n"),
    );

    try {
      const loaded = await loadHotUpdater("src/db.ts", {
        cwd: projectDir,
        allowGeneratedSchemaVirtualModule: true,
      });
      expect(await readFile(effectPath, "utf-8")).toBe("x");
      await loaded.dispose();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
});
