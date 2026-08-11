import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

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
}));

vi.mock("@hot-updater/cli-tools", () => ({
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

vi.mock("./utils/load-hot-updater", () => ({
  loadHotUpdater: vi.fn(),
}));

vi.mock("@hot-updater/server/db", () => ({
  createMigrator: mockServer.createMigrator,
  generateSchema: mockServer.generateSchema,
}));

describe("generate command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("rejects MongoDB migration file generation after disposing loaded config", async () => {
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
        "MongoDB does not support migration file generation.",
      ),
    );
    expect(mockCli.log.error).toHaveBeenCalledWith(
      expect.stringContaining("hot-updater db migrate"),
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(events).toEqual(["dispose", "exit:1"]);
  });

  it("generates standalone MySQL SQL without a real connection pool", async () => {
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

      expect(sql).toContain("CREATE TABLE IF NOT EXISTS bundles");
      expect(sql).toContain("`key` varchar(255) PRIMARY KEY");
      expect(sql).toContain("ON DUPLICATE KEY UPDATE");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
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
