import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadHotUpdater } from "./load-hot-updater";

vi.mock("@hot-updater/cli-tools", () => ({
  p: { log: { error: vi.fn(), info: vi.fn(), message: vi.fn() } },
}));

const temporaryDirectories = new Set<string>();

describe("generated schema Jiti CommonJS semantics", () => {
  afterEach(async () => {
    await Promise.all(
      [...temporaryDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    temporaryDirectories.clear();
  });

  it.each([
    ["CommonJS .cjs with CR", "db.cjs", "\r"],
    ["CommonJS .cjs with Unicode line separator", "db.cjs", "\u2028"],
    ["CommonJS .cts with LF", "db.cts", "\n"],
    ["CommonJS .js with LF", "db.js", "\n"],
  ])("preserves the CommonJS wrapper for %s", async (_, configName, eol) => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-commonjs-wrapper-"),
    );
    temporaryDirectories.add(projectDir);
    const stateKey = `hotUpdaterCommonJsWrapper${Date.now()}`;
    await writeFile(
      path.join(projectDir, configName),
      [
        "#!/usr/bin/env node",
        '"use strict";',
        "if (false) return;",
        `globalThis[${JSON.stringify(stateKey)}] = (globalThis[${JSON.stringify(stateKey)}] ?? 0) + 1;`,
        'const { PrismaClient } = require("./generated/prisma");',
        "this.hotUpdater = {",
        `  adapterName: [this === exports, arguments.length, arguments[0] === exports, __filename.endsWith(${JSON.stringify(configName)}), __dirname === ${JSON.stringify(projectDir)}, PrismaClient.name, globalThis[${JSON.stringify(stateKey)}]].join(":"),`,
        "};",
      ].join(eol),
    );

    try {
      const loaded = await loadHotUpdater(configName, {
        cwd: projectDir,
        allowGeneratedSchemaVirtualModule: true,
      });
      expect(loaded.adapterName).toBe("true:5:true:true:true:PrismaClient:1");
      expect(Reflect.get(globalThis, stateKey)).toBe(1);
    } finally {
      Reflect.deleteProperty(globalThis, stateKey);
    }
  });

  it.each([
    ["db.cjs", false],
    ["db.cts", false],
    ["db.js", false],
    ["db.js", true],
  ])(
    "keeps ESM syntax at module scope in %s (type module: %s)",
    async (configName, typeModule) => {
      const projectDir = await mkdtemp(
        path.join(tmpdir(), "hot-updater-esm-syntax-wrapper-"),
      );
      temporaryDirectories.add(projectDir);
      if (typeModule) {
        await writeFile(
          path.join(projectDir, "package.json"),
          JSON.stringify({ type: "module" }),
        );
      }
      await writeFile(
        path.join(projectDir, configName),
        [
          'import { PrismaClient } from "./generated/prisma";',
          "export const hotUpdater = {",
          "  adapterName: new PrismaClient().constructor.name,",
          "};",
        ].join("\n"),
      );

      const loaded = await loadHotUpdater(configName, {
        cwd: projectDir,
        allowGeneratedSchemaVirtualModule: true,
      });
      expect(loaded.adapterName).toBe("PrismaClient");
    },
  );

  it("does not mask an invalid package boundary", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-invalid-package-json-"),
    );
    temporaryDirectories.add(projectDir);
    await writeFile(path.join(projectDir, "package.json"), "{");
    await writeFile(
      path.join(projectDir, "db.js"),
      'this.hotUpdater = { adapterName: "masked" };',
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(
        loadHotUpdater("db.js", {
          cwd: projectDir,
          allowGeneratedSchemaVirtualModule: true,
        }),
      ).rejects.toThrow("process.exit(1)");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("does not let invalid source escape the CommonJS wrapper", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-commonjs-wrapper-escape-"),
    );
    temporaryDirectories.add(projectDir);
    await writeFile(
      path.join(projectDir, "db.cjs"),
      [
        "}",
        ").call(exports, exports, require, module, __filename, __dirname);",
        'exports.hotUpdater = { adapterName: "escaped" };',
        "(function (exports, require, module, __filename, __dirname) {",
      ].join("\n"),
    );
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
    }
  });

  it("uses the real config path for package type lookup", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-symlink-package-type-"),
    );
    temporaryDirectories.add(projectDir);
    const commonJsDir = path.join(projectDir, "common");
    const aliasDir = path.join(projectDir, "alias");
    await mkdir(commonJsDir);
    await writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      path.join(commonJsDir, "package.json"),
      JSON.stringify({ type: "commonjs" }),
    );
    await writeFile(
      path.join(commonJsDir, "db.js"),
      [
        "if (false) return;",
        'const { PrismaClient } = require("./generated/prisma");',
        "this.hotUpdater = { adapterName: PrismaClient.name };",
      ].join("\n"),
    );
    await symlink(
      commonJsDir,
      aliasDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    const loaded = await loadHotUpdater("alias/db.js", {
      cwd: projectDir,
      allowGeneratedSchemaVirtualModule: true,
    });
    expect(loaded.adapterName).toBe("PrismaClient");
  });
});
