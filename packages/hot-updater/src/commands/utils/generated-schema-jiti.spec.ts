import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { createRequire } from "module";
import { tmpdir } from "os";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadHotUpdater } from "./load-hot-updater";

vi.mock("@hot-updater/cli-tools", () => ({
  p: { log: { error: vi.fn(), info: vi.fn(), message: vi.fn() } },
}));

const temporaryDirectories = new Set<string>();
const localRequire = createRequire(import.meta.url);

describe("generated schema Jiti cache", () => {
  afterEach(async () => {
    await Promise.all(
      [...temporaryDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    temporaryDirectories.clear();
  });

  it("preserves the default cache behavior for ordinary config loads", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-default-jiti-cache-"),
    );
    temporaryDirectories.add(projectDir);
    const configPath = path.join(projectDir, "db.cjs");
    const stateKey = `hotUpdaterConfigLoad${Date.now()}`;
    await writeFile(
      configPath,
      [
        `globalThis[${JSON.stringify(stateKey)}] = (globalThis[${JSON.stringify(stateKey)}] ?? 0) + 1;`,
        `exports.hotUpdater = { adapterName: String(globalThis[${JSON.stringify(stateKey)}]) };`,
      ].join("\n"),
    );

    try {
      const first = await loadHotUpdater("db.cjs", { cwd: projectDir });
      const second = await loadHotUpdater("db.cjs", { cwd: projectDir });
      expect(first.adapterName).toBe("1");
      expect(second.adapterName).toBe("1");
      expect(Reflect.get(globalThis, stateKey)).toBe(1);
    } finally {
      delete localRequire.cache[localRequire.resolve(configPath)];
      Reflect.deleteProperty(globalThis, stateKey);
    }
  });

  it("keeps dependencies outside the virtualized project graph cached", async () => {
    const testDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-jiti-cache-"),
    );
    temporaryDirectories.add(testDir);
    const projectDir = path.join(testDir, "project");
    const externalPath = path.join(testDir, "external.cjs");
    const stateKey = `hotUpdaterExternalLoad${Date.now()}`;
    await mkdir(projectDir);
    await writeFile(
      externalPath,
      [
        `globalThis[${JSON.stringify(stateKey)}] = (globalThis[${JSON.stringify(stateKey)}] ?? 0) + 1;`,
        `module.exports = globalThis[${JSON.stringify(stateKey)}];`,
      ].join("\n"),
    );
    await writeFile(
      path.join(projectDir, "db.cjs"),
      [
        `const externalLoads = require(${JSON.stringify(externalPath)});`,
        'const { PrismaClient } = require("./generated/prisma");',
        "const prisma = new PrismaClient();",
        "exports.hotUpdater = { adapterName: `${prisma.constructor.name}:${externalLoads}` };",
      ].join("\n"),
    );

    try {
      const loaded = await loadHotUpdater("db.cjs", {
        cwd: projectDir,
        allowGeneratedSchemaVirtualModule: true,
      });
      expect(loaded.adapterName).toBe("PrismaClient:1");
      expect(localRequire(externalPath)).toBe(1);
      expect(Reflect.get(globalThis, stateKey)).toBe(1);
    } finally {
      delete localRequire.cache[localRequire.resolve(externalPath)];
      Reflect.deleteProperty(globalThis, stateKey);
    }
  });

  it("does not evict project dependencies for an erased type-only import", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-type-only-jiti-cache-"),
    );
    temporaryDirectories.add(projectDir);
    const configPath = path.join(projectDir, "db.ts");
    const statePath = path.join(projectDir, "state.cjs");
    const stateKey = `hotUpdaterTypeOnlyLoad${Date.now()}`;
    await writeFile(
      statePath,
      [
        `globalThis[${JSON.stringify(stateKey)}] = (globalThis[${JSON.stringify(stateKey)}] ?? 0) + 1;`,
        `module.exports = globalThis[${JSON.stringify(stateKey)}];`,
      ].join("\n"),
    );
    await writeFile(
      configPath,
      [
        'import type { PrismaClient } from "./generated/prisma";',
        'import state from "./state.cjs";',
        "export const hotUpdater = { adapterName: String(state) };",
      ].join("\n"),
    );

    try {
      const loaded = await loadHotUpdater("db.ts", {
        cwd: projectDir,
        allowGeneratedSchemaVirtualModule: true,
      });
      expect(loaded.adapterName).toBe("1");
      expect(localRequire(statePath)).toBe(1);
      expect(Reflect.get(globalThis, stateKey)).toBe(1);
    } finally {
      delete localRequire.cache[localRequire.resolve(statePath)];
      Reflect.deleteProperty(globalThis, stateKey);
    }
  });
});
