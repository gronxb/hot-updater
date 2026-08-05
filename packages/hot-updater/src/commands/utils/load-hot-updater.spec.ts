import { existsSync } from "fs";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadHotUpdater } from "./load-hot-updater";

const mockCli = vi.hoisted(() => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", () => ({
  p: {
    log: mockCli.log,
  },
}));

describe("loadHotUpdater", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bootstraps a missing generated Drizzle schema when allowed", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-load-config-"),
    );
    const srcDir = path.join(projectDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "drizzle.ts"),
      [
        'import * as schema from "../hot-updater-schema";',
        "export const schemaKeys = Object.keys(schema);",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(srcDir, "db.ts"),
      [
        'import { schemaKeys } from "./drizzle";',
        "export const hotUpdater = {",
        '  adapterName: schemaKeys.length === 0 ? "drizzle" : "polluted",',
        "  generateSchema: () => ({ code: '', path: 'hot-updater-schema.ts' }),",
        "};",
      ].join("\n"),
      "utf-8",
    );

    try {
      const loaded = await loadHotUpdater("src/db.ts", {
        cwd: projectDir,
        allowGeneratedSchemaVirtualModule: true,
      });
      expect(loaded.adapterName).toBe("drizzle");

      expect(existsSync(path.join(projectDir, "hot-updater-schema.ts"))).toBe(
        false,
      );
      await loaded.dispose();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("reports an invalid config after bootstrapping its generated schema", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-invalid-config-"),
    );
    const srcDir = path.join(projectDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "drizzle.ts"),
      ['import "../hot-updater-schema";'].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(srcDir, "db.ts"),
      ['import "./drizzle";', 'export const value = "invalid";'].join("\n"),
      "utf-8",
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(
        loadHotUpdater("src/db.ts", {
          cwd: projectDir,
          allowGeneratedSchemaVirtualModule: true,
        }),
      ).rejects.toThrow("process.exit(1)");

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("bootstraps a custom generated schema import when allowed", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-custom-schema-"),
    );
    const srcDir = path.join(projectDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "drizzle.ts"),
      ['import "../custom-hot-updater-schema";'].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(srcDir, "db.ts"),
      [
        'import "./drizzle";',
        "export const hotUpdater = {",
        '  adapterName: "drizzle",',
        "  generateSchema: () => ({ code: '', path: 'custom-hot-updater-schema.ts' }),",
        "};",
      ].join("\n"),
      "utf-8",
    );

    try {
      const loaded = await loadHotUpdater("src/db.ts", {
        cwd: projectDir,
        allowGeneratedSchemaVirtualModule: true,
      });
      expect(loaded.adapterName).toBe("drizzle");

      await loaded.dispose();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("accepts root runtime configs without direct database tooling methods", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-root-runtime-config-"),
    );
    await writeFile(
      path.join(projectDir, "hot-updater.config.ts"),
      ["export const hotUpdater = {", '  adapterName: "kysely",', "};"].join(
        "\n",
      ),
      "utf-8",
    );

    try {
      const loaded = await loadHotUpdater("", { cwd: projectDir });
      expect(loaded.adapterName).toBe("kysely");
      expect("createMigrator" in loaded.hotUpdater).toBe(false);
      expect("generateSchema" in loaded.hotUpdater).toBe(false);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
