import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
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

type ShadowedRequireLayout =
  | "array-pattern"
  | "nested"
  | "object-pattern"
  | "top-level";

function createShadowedRequireStatements(
  layout: ShadowedRequireLayout,
): readonly string[] {
  const loadExpression =
    'const { PrismaClient } = require("./generated/prisma");';
  switch (layout) {
    case "top-level":
      return [
        "const require = loadModule;",
        loadExpression,
        "const prisma = new PrismaClient();",
      ];
    case "nested":
      return [
        "function createPrisma() {",
        "  const require = loadModule;",
        `  ${loadExpression}`,
        "  return new PrismaClient();",
        "}",
        "const prisma = createPrisma();",
      ];
    case "object-pattern":
      return [
        "const { require } = { require: loadModule };",
        loadExpression,
        "const prisma = new PrismaClient();",
      ];
    case "array-pattern":
      return [
        "const [require] = [loadModule];",
        loadExpression,
        "const prisma = new PrismaClient();",
      ];
  }
}

describe("generated schema CommonJS safety", () => {
  it("does not mask a forged module-resolution error", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-forged-module-error-"),
    );
    const srcDir = path.join(projectDir, "src");
    const importerPath = path.join(srcDir, "prisma.cjs");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "forged.cjs"),
      [
        "const error = new Error(\"Cannot find module './generated/prisma'\");",
        'error.code = "MODULE_NOT_FOUND";',
        `error.requireStack = [${JSON.stringify(importerPath)}];`,
        "throw error;",
      ].join("\n"),
    );
    await writeFile(
      importerPath,
      [
        'const { PrismaClient } = require("./generated/prisma");',
        "exports.prisma = new PrismaClient();",
      ].join("\n"),
    );
    await writeFile(
      path.join(srcDir, "db.cjs"),
      [
        'require("./forged");',
        'const { prisma } = require("./prisma");',
        "exports.hotUpdater = { adapterName: prisma.constructor.name };",
      ].join("\n"),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(
        loadHotUpdater("src/db.cjs", {
          cwd: projectDir,
          allowGeneratedSchemaVirtualModule: true,
        }),
      ).rejects.toThrow("process.exit(1)");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it.each<ShadowedRequireLayout>([
    "top-level",
    "nested",
    "object-pattern",
    "array-pattern",
  ])("does not rewrite a %s shadowed require binding", async (layout) => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-shadowed-require-"),
    );
    const configPath = path.join(projectDir, "db.cjs");
    const body = [
      "function loadModule(request) {",
      '  if (request === "./generated/prisma") {',
      "    const error = new Error(\"Cannot find module './generated/prisma'\");",
      '    error.code = "MODULE_NOT_FOUND";',
      "    error.requireStack = [__filename];",
      "    throw error;",
      "  }",
      "  return { PrismaClient: class ShadowedPrismaClient {} };",
      "}",
      ...createShadowedRequireStatements(layout),
      "exports.hotUpdater = { adapterName: prisma.constructor.name };",
    ];
    await writeFile(configPath, body.join("\n"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(
        loadHotUpdater("db.cjs", {
          cwd: projectDir,
          allowGeneratedSchemaVirtualModule: true,
        }),
      ).rejects.toThrow("process.exit(1)");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
