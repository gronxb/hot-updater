import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { insights } from "@hot-updater/server/plugins/insights";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generate } from "./generate";
import {
  loadHotUpdater,
  type LoadHotUpdaterResult,
} from "./utils/load-hot-updater";

const mockCli = vi.hoisted(() => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  outro: vi.fn(),
  spinner: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));
const mockServer = vi.hoisted(() => ({
  createMigrator: vi.fn(),
  generateSchema: vi.fn(),
  generatesSchema: vi.fn(() => false),
}));
const mockPlugins = vi.hoisted(() => ({
  findPluginList: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", () => ({
  HOT_UPDATER_PLUGINS_PATH: "hotUpdater.plugins.ts",
  colors: {
    blue: (value: string) => value,
    cyan: (value: string) => value,
    dim: (value: string) => value,
    green: (value: string) => value,
    magenta: (value: string) => value,
    red: (value: string) => value,
    yellow: (value: string) => value,
  },
  p: {
    cancel: mockCli.cancel,
    confirm: mockCli.confirm,
    isCancel: mockCli.isCancel,
    log: mockCli.log,
    outro: mockCli.outro,
    spinner: vi.fn(() => mockCli.spinner),
  },
}));

vi.mock("./utils/load-hot-updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/load-hot-updater")>()),
  loadHotUpdater: vi.fn(),
}));

vi.mock("@hot-updater/server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/server/db")>()),
  createMigrator: mockServer.createMigrator,
  generateSchema: mockServer.generateSchema,
  generatesSchema: mockServer.generatesSchema,
}));

vi.mock("./pluginCommands", () => ({
  findPluginList: mockPlugins.findPluginList,
}));

describe("generate command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlugins.findPluginList.mockResolvedValue(undefined);
    mockServer.generatesSchema.mockReturnValue(false);
    mockServer.createMigrator.mockReturnValue({
      migrateToLatest: vi.fn(async () => ({
        getSQL: () =>
          "create table if not exists bundles (id text primary key);\n" +
          "create table if not exists private_hot_updater_settings (`key` varchar(255) primary key);\n" +
          "insert into private_hot_updater_settings (`key`, value) values ('version', '0.34.0') on duplicate key update value = values(value);",
      })),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects generation for a database without schema files after disposing loaded config", async () => {
    const events: string[] = [];
    const dispose = vi.fn(async () => {
      events.push("dispose");
    });
    const loadedConfig: LoadHotUpdaterResult = {
      absoluteConfigPath: "/repo/src/db.ts",
      adapterName: "mongodb",
      dispose,
      hotUpdater: {
        adapterName: "mongodb",
      },
    };

    vi.mocked(loadHotUpdater).mockResolvedValue(loadedConfig);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      events.push(`exit:${code}`);
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      generate({ configPath: "src/db.ts", skipConfirm: true }),
    ).rejects.toThrow("process.exit(1)");

    expect(mockCli.spinner.stop).toHaveBeenCalledWith(
      "Generation not supported",
    );
    expect(mockCli.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "The mongodb database does not generate schema files.",
      ),
    );
    expect(mockCli.log.error).toHaveBeenCalledWith(
      expect.stringContaining("hot-updater db migrate"),
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(events).toEqual(["dispose", "exit:1"]);
  });

  it("generates standalone MySQL SQL of core's tables without a plugin list, and says so", async () => {
    const outputDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-mysql-sql-"),
    );

    try {
      await generate({
        configPath: "",
        outputDir,
        skipConfirm: true,
        sql: "mysql",
      });

      const sql = await readFile(
        path.join(outputDir, "hot-updater.sql"),
        "utf-8",
      );

      expect(mockPlugins.findPluginList).toHaveBeenCalledWith(
        [],
        process.cwd(),
        [],
      );
      expect(mockCli.log.info).toHaveBeenCalledWith(
        "No server config or hotUpdater.plugins.ts found, so the SQL holds core's tables only.",
      );
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `?bundles`?/u);
      expect(sql).toContain("private_hot_updater_settings");
      expect(sql).not.toContain("bundle_events");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("adds the tables and settings rows of the plugins it finds", async () => {
    const outputDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-plugin-sql-"),
    );
    mockPlugins.findPluginList.mockResolvedValue({
      from: "hotUpdater.plugins.ts",
      plugins: [insights()],
    });

    try {
      await generate({
        configPath: "",
        outputDir,
        skipConfirm: true,
        sql: "postgresql",
      });

      const sql = await readFile(
        path.join(outputDir, "hot-updater.sql"),
        "utf-8",
      );
      expect(mockCli.log.info).toHaveBeenCalledWith(
        "Adding the tables of the plugins in hotUpdater.plugins.ts.",
      );
      expect(sql).toContain("bundle_events");
      expect(sql).toContain("schema.insights");
      expect(sql).not.toContain("api_keys");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("reads the plugins of the server config the first argument names, and writes to the second", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "hot-updater-config-sql-"),
    );
    const configPath = path.join(directory, "hotUpdater.ts");
    const outputDir = path.join(directory, "out");
    await writeFile(configPath, "export {};\n", "utf-8");

    try {
      await generate({
        configPath,
        outputDir,
        skipConfirm: true,
        sql: "sqlite",
      });

      expect(mockPlugins.findPluginList).toHaveBeenCalledWith(
        [configPath],
        process.cwd(),
        [],
      );
      await expect(
        stat(path.join(outputDir, "hot-updater.sql")),
      ).resolves.toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes Drizzle schema generation to the adapter artifact path", async () => {
    const outputDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-drizzle-schema-"),
    );
    const dispose = vi.fn();
    const loadedConfig: LoadHotUpdaterResult = {
      absoluteConfigPath: "/repo/src/db.ts",
      adapterName: "drizzle",
      dispose,
      hotUpdater: {
        adapterName: "drizzle",
      },
    };
    mockServer.generateSchema.mockReturnValue({
      code: "export const bundles = {};",
      path: "db/hot-updater-schema.ts",
    });
    vi.mocked(loadHotUpdater).mockResolvedValue(loadedConfig);

    try {
      await mkdir(path.join(outputDir, "db"), { recursive: true });
      await writeFile(
        path.join(outputDir, "db", "hot-updater-schema.ts"),
        "export const stale = true;",
        "utf-8",
      );

      await generate({
        configPath: "src/db.ts",
        outputDir,
        skipConfirm: true,
      });

      await expect(
        readFile(path.join(outputDir, "db", "hot-updater-schema.ts"), "utf-8"),
      ).resolves.toBe("export const bundles = {};");
      await expect(
        stat(path.join(outputDir, "hot-updater-schema.ts")),
      ).rejects.toThrow();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("writes a provider's migration once, skipping a rerun that repeats it", async () => {
    const outputDir = await mkdtemp(
      path.join(tmpdir(), "hot-updater-supabase-migration-"),
    );
    const loadedConfig: LoadHotUpdaterResult = {
      absoluteConfigPath: "/repo/src/db.ts",
      adapterName: "supabaseDatabase",
      dispose: vi.fn(),
      hotUpdater: {
        adapterName: "supabaseDatabase",
      },
    };
    const migrations = path.join(outputDir, "supabase", "migrations");
    mockServer.generatesSchema.mockReturnValue(true);
    mockServer.generateSchema
      .mockReturnValueOnce({
        code: "CREATE TABLE notes_notes (id text);\n",
        path: "supabase/migrations/20260924000000_hot-updater.sql",
      })
      .mockReturnValueOnce({
        code: "CREATE TABLE notes_notes (id text);\n",
        path: "supabase/migrations/20260924000100_hot-updater.sql",
      });
    vi.mocked(loadHotUpdater).mockResolvedValue(loadedConfig);

    try {
      await generate({ configPath: "src/db.ts", outputDir, skipConfirm: true });
      await generate({ configPath: "src/db.ts", outputDir, skipConfirm: true });

      await expect(readdir(migrations)).resolves.toEqual([
        "20260924000000_hot-updater.sql",
      ]);
      expect(mockCli.log.warn).toHaveBeenCalledWith(
        "Identical migration already exists: 20260924000000_hot-updater.sql",
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("disposes loaded config before exiting on schema generation cancellation", async () => {
    const events: string[] = [];
    const dispose = vi.fn(async () => {
      events.push("dispose");
    });
    const loadedConfig: LoadHotUpdaterResult = {
      absoluteConfigPath: "/repo/src/db.ts",
      adapterName: "drizzle",
      dispose,
      hotUpdater: {
        adapterName: "drizzle",
      },
    };
    mockServer.generateSchema.mockReturnValue({
      code: "export const bundles = {};",
      path: "hot-updater-schema.ts",
    });
    vi.mocked(loadHotUpdater).mockResolvedValue(loadedConfig);
    mockCli.confirm.mockResolvedValue(false);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      events.push(`exit:${code}`);
      throw new Error(`process.exit(${code})`);
    });

    await expect(
      generate({ configPath: "src/db.ts", skipConfirm: false }),
    ).rejects.toThrow("process.exit(0)");

    expect(mockCli.cancel).toHaveBeenCalledWith("Operation cancelled");
    expect(dispose).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(events).toEqual(["dispose", "exit:0"]);
  });
});
