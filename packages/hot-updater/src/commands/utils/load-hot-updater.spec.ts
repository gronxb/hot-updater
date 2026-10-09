import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadHotUpdater } from "./load-hot-updater";

const mockCli = vi.hoisted(() => ({
  loadConfig: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  // How tooling reads a definition, and the output's colors, stay real.
  const { colors, isServerDefinition, serverDefinitionOf } =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    colors,
    isServerDefinition,
    loadConfig: mockCli.loadConfig,
    p: {
      log: mockCli.log,
    },
    serverDefinitionOf,
  };
});

/**
 * A module that exports a server definition, as `createHotUpdater` returns
 * one, on a database named by the `name` expression, with `tooling` among
 * the database's members.
 */
const definitionSource = (name: string, tooling = "") =>
  [
    "export const hotUpdater = {",
    `  database: { name: ${name}${tooling ? `, ${tooling}` : ""} },`,
    "  plugins: [],",
    "  clientPlugins: [],",
    "  clientEndpoints: [],",
    "  core: {},",
    "  api: {},",
    "};",
  ].join("\n");

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
        'import "./drizzle";',
        definitionSource(
          '"drizzle"',
          "generateSchema: () => ({ code: '', path: 'hot-updater-schema.ts' })",
        ),
      ].join("\n"),
      "utf-8",
    );

    try {
      const loaded = await loadHotUpdater("src/db.ts", {
        cwd: projectDir,
        allowGeneratedSchemaPlaceholder: true,
      });
      expect(loaded.adapterName).toBe("drizzle");

      const placeholderPath = path.join(projectDir, "hot-updater-schema.ts");
      expect(await readFile(placeholderPath, "utf-8")).toContain(
        "Temporary placeholder",
      );

      await loaded.dispose();

      await expect(readFile(placeholderPath, "utf-8")).rejects.toThrow();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("removes the generated schema placeholder before exiting on invalid config", async () => {
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
          allowGeneratedSchemaPlaceholder: true,
        }),
      ).rejects.toThrow("process.exit(1)");

      await expect(
        readFile(path.join(projectDir, "hot-updater-schema.ts"), "utf-8"),
      ).rejects.toThrow();
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
        definitionSource(
          '"drizzle"',
          "generateSchema: () => ({ code: '', path: 'custom-hot-updater-schema.ts' })",
        ),
      ].join("\n"),
      "utf-8",
    );

    try {
      const loaded = await loadHotUpdater("src/db.ts", {
        cwd: projectDir,
        allowGeneratedSchemaPlaceholder: true,
      });
      expect(loaded.adapterName).toBe("drizzle");

      const placeholderPath = path.join(
        projectDir,
        "custom-hot-updater-schema.ts",
      );
      expect(await readFile(placeholderPath, "utf-8")).toContain(
        "Temporary placeholder",
      );

      await loaded.dispose();

      await expect(readFile(placeholderPath, "utf-8")).rejects.toThrow();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("loads a server definition the command names without running hot-updater.config.ts", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-named-server-"),
    );
    await writeFile(
      path.join(projectDir, "hotUpdater.ts"),
      definitionSource("process.env.HOT_UPDATER_TEST_ADAPTER"),
      "utf-8",
    );
    await writeFile(
      path.join(projectDir, ".env.hotupdater"),
      "HOT_UPDATER_TEST_ADAPTER=kysely\n",
      "utf-8",
    );
    mockCli.loadConfig.mockRejectedValueOnce(
      new Error("HOT_UPDATER_ADMIN_TOKEN is required."),
    );

    try {
      const loaded = await loadHotUpdater("hotUpdater.ts", { cwd: projectDir });
      expect(loaded.adapterName).toBe("kysely");
      expect(mockCli.loadConfig).not.toHaveBeenCalled();
    } finally {
      delete process.env["HOT_UPDATER_TEST_ADAPTER"];
      mockCli.loadConfig.mockReset();
      mockCli.loadConfig.mockResolvedValue({});
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("loads src/hotUpdater.ts by default, without running hot-updater.config.ts", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-default-server-"),
    );
    const definitionPath = path.join(projectDir, "src", "hotUpdater.ts");
    await mkdir(path.dirname(definitionPath), { recursive: true });
    await writeFile(definitionPath, definitionSource('"kysely"'), "utf-8");
    mockCli.loadConfig.mockRejectedValueOnce(
      new Error("hot-updater.config.ts must not load."),
    );

    try {
      const loaded = await loadHotUpdater("", { cwd: projectDir });
      expect(loaded.absoluteConfigPath).toBe(definitionPath);
      expect(loaded.adapterName).toBe("kysely");
      expect(mockCli.loadConfig).not.toHaveBeenCalled();
      expect("createMigrator" in loaded.hotUpdater).toBe(false);
      expect("generateSchema" in loaded.hotUpdater).toBe(false);
    } finally {
      mockCli.loadConfig.mockReset();
      mockCli.loadConfig.mockResolvedValue({});
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("closes the definition's database when its module exports no closeDatabase", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-dispose-server-"),
    );
    await writeFile(
      path.join(projectDir, "hotUpdater.ts"),
      definitionSource(
        '"kysely"',
        "dispose: async () => { globalThis.__HOT_UPDATER_TEST_DISPOSED__ = true; }",
      ),
      "utf-8",
    );

    try {
      const loaded = await loadHotUpdater("hotUpdater.ts", { cwd: projectDir });
      await loaded.dispose();
      expect(Reflect.get(globalThis, "__HOT_UPDATER_TEST_DISPOSED__")).toBe(
        true,
      );
    } finally {
      Reflect.deleteProperty(globalThis, "__HOT_UPDATER_TEST_DISPOSED__");
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("names the paths to pass or create when it finds no server definition", async () => {
    const projectDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-no-server-"),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(loadHotUpdater("", { cwd: projectDir })).rejects.toThrow(
        "process.exit(1)",
      );
      expect(mockCli.log.error).toHaveBeenCalledWith(
        "Could not find a server definition: pass its path, or keep it in src/hotUpdater.ts or src/db.ts.",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockCli.loadConfig).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
