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

type RequireGraphLayout = "branching" | "direct" | "transitive";

function createRequireGraphConfig(
  layout: RequireGraphLayout,
  effectPath: string,
): string {
  const recordEffect = `require("fs").appendFileSync(${JSON.stringify(effectPath)}, "x");`;
  switch (layout) {
    case "direct":
      return [
        recordEffect,
        'const { PrismaClient } = require("./generated/prisma");',
        "const prisma = new PrismaClient();",
        "exports.hotUpdater = { adapterName: prisma.constructor.name };",
        "exports.closeDatabase = () => prisma.$disconnect();",
      ].join("\n");
    case "transitive":
      return [
        recordEffect,
        'const { source } = require("./a");',
        "exports.hotUpdater = { adapterName: source };",
      ].join("\n");
    case "branching":
      return [
        recordEffect,
        'const { source } = require("./a");',
        'const { siblingSource } = require("./b");',
        "exports.hotUpdater = {",
        "  adapterName: `${source}:${siblingSource}`",
        "};",
      ].join("\n");
  }
}

function getRequireGraphNames(layout: RequireGraphLayout): {
  generated: string;
  initial: string;
} {
  switch (layout) {
    case "direct":
    case "transitive":
      return {
        generated: "GeneratedPrismaClient",
        initial: "PrismaClient",
      };
    case "branching":
      return {
        generated: "GeneratedPrismaClient:GeneratedPrismaClient",
        initial: "PrismaClient:PrismaClient",
      };
  }
}

function createRequireExpressionConfig(layout: "member" | "nested"): string {
  switch (layout) {
    case "member":
      return [
        "function loadOther(require) { return require('./other'); }",
        'const PrismaClient = require("./generated/prisma").PrismaClient;',
        "const prisma = new PrismaClient();",
        "exports.hotUpdater = { adapterName: prisma.constructor.name };",
      ].join("\n");
    case "nested":
      return [
        "function loadOther(require) { return require('./other'); }",
        "function createPrisma() {",
        '  const { PrismaClient } = require("./generated/prisma");',
        "  return new PrismaClient();",
        "}",
        "const prisma = createPrisma();",
        "exports.hotUpdater = { adapterName: prisma.constructor.name };",
      ].join("\n");
  }
}

describe("generated schema virtual module in CommonJS", () => {
  it.each<RequireGraphLayout>(["direct", "transitive", "branching"])(
    "loads the generated client without replaying the root of a %s require graph",
    async (layout) => {
      const projectDir = await mkdtemp(
        path.join(tmpdir(), "hot-updater-commonjs-virtual-module-"),
      );
      const srcDir = path.join(projectDir, "src");
      const generatedDir = path.join(srcDir, "generated");
      const effectPath = path.join(projectDir, "effect.txt");
      await mkdir(srcDir, { recursive: true });
      if (layout !== "direct") {
        await writeFile(
          path.join(srcDir, "a.cjs"),
          [
            'const { PrismaClient } = require("./generated/prisma");',
            "exports.source = new PrismaClient().constructor.name;",
          ].join("\n"),
        );
      }
      if (layout === "branching") {
        await writeFile(
          path.join(srcDir, "b.cjs"),
          [
            'const { source } = require("./a");',
            "exports.siblingSource = source;",
          ].join("\n"),
        );
      }
      await writeFile(
        path.join(srcDir, "db.cjs"),
        createRequireGraphConfig(layout, effectPath),
      );
      const names = getRequireGraphNames(layout);

      try {
        const initialLoad = await loadHotUpdater("src/db.cjs", {
          cwd: projectDir,
          allowGeneratedSchemaVirtualModule: true,
        });
        expect(initialLoad.adapterName).toBe(names.initial);
        await initialLoad.dispose();
        expect(await readFile(effectPath, "utf8")).toBe("x");

        await mkdir(generatedDir);
        await writeFile(
          path.join(generatedDir, "prisma.js"),
          [
            "class GeneratedPrismaClient {",
            "  async $disconnect() {}",
            "}",
            "exports.PrismaClient = GeneratedPrismaClient;",
          ].join("\n"),
        );
        const generatedLoad = await loadHotUpdater("src/db.cjs", {
          cwd: projectDir,
          allowGeneratedSchemaVirtualModule: true,
        });
        expect(generatedLoad.adapterName).toBe(names.generated);
        await generatedLoad.dispose();
        expect(await readFile(effectPath, "utf8")).toBe("xx");
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    },
  );

  it.each<"member" | "nested">(["member", "nested"])(
    "bootstraps an unshadowed %s require expression",
    async (layout) => {
      const projectDir = await mkdtemp(
        path.join(tmpdir(), "hot-updater-commonjs-expression-"),
      );
      const configPath = path.join(projectDir, "db.cjs");
      await writeFile(configPath, createRequireExpressionConfig(layout));

      try {
        const loaded = await loadHotUpdater("db.cjs", {
          cwd: projectDir,
          allowGeneratedSchemaVirtualModule: true,
        });
        expect(loaded.adapterName).toBe("PrismaClient");
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    },
  );
});
