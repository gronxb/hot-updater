import {
  createMigrator,
  loadConfig,
  readPackageUp,
} from "@hot-updater/cli-tools";
import {
  type AnyHotUpdaterPlugin,
  createEngineDatabase,
  createMemoryAdapter,
  type DatabaseAdapter,
  definePlugin,
  defineTable,
  migrateCoreSchema,
  SETTINGS_TABLE,
  type ToolingDatabase,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiKeys, insights, remoteConfig } from "../plugins";
import { loadServer } from "../utils/loadServer";
import { testServer } from "../utils/testServer";
import { doctor } from "./doctor";
import { initReplayCommand } from "./initProviders";

vi.mock("../packageJson", () => ({ packageJsonData: { version: "1.0.0" } }));

vi.mock("../utils/loadServer", () => ({ loadServer: vi.fn() }));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(() => "/project"),
  loadConfig: vi.fn(),
  readPackageUp: vi.fn(),
}));

/** A plugin a later release adds to the managed database. */
const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable({ id: { type: "string" } }, { key: ["id"] }),
  },
  init: () => ({ api: {} }),
});

let adapter: DatabaseAdapter;

/**
 * A fenced database on a memory adapter, as a provider gives the CLI. Doctor
 * closes it after each run, which would empty the memory, so it keeps open.
 */
const database = (name = "memory", tooling: Partial<ToolingDatabase> = {}) => {
  const { dispose: _dispose, ...fenced } = createEngineDatabase({
    name,
    adapter,
  });
  return { ...fenced, ...tooling };
};

/** A server project whose hot-updater.config.ts names `configured` and `plugins`. */
const serverProject = (
  configured: ToolingDatabase,
  plugins: readonly AnyHotUpdaterPlugin[] = [notes],
) => {
  vi.mocked(readPackageUp).mockResolvedValue({
    packageJson: { dependencies: { "hot-updater": "1.0.0" } },
    path: "/project/package.json",
  } as never);
  vi.mocked(loadConfig).mockResolvedValue({
    database: configured,
    plugins,
  } as never);
  vi.mocked(loadServer).mockImplementation(async () =>
    testServer({ database: configured, plugins }),
  );
};

/** Sets a settings row, as an earlier or later release's migration left it. */
const storeSetting = async (key: string, value: string) => {
  const [row] = await adapter.get(SETTINGS_TABLE, [[key]]);
  await adapter.write([
    row === null
      ? { type: "insert", table: SETTINGS_TABLE, row: { key, value, _v: 0 } }
      : {
          type: "patch",
          table: SETTINGS_TABLE,
          key: [key],
          set: { value },
          guard: { v: Number(row!["_v"]) },
          previous: row!,
        },
  ]);
};

/** The order every SCHEMA_MIGRATION_PENDING resolution states. */
const ORDER =
  "A server of an earlier release answers 503 once the database is migrated, and a server of this release answers 503 until it is";

const DB_MIGRATE = "npx hot-updater db migrate <server file>";
const DB_GENERATE = "npx hot-updater db generate <server file>";

describe("doctor's schema check", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = createMemoryAdapter();
    // Core's tables, as an earlier release's init created them.
    await migrateCoreSchema(adapter, "memory");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes when the fence does", async () => {
    await migrateCoreSchema(adapter, "memory", [notes]);
    serverProject(database());

    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: { releaseCatalogs: { issues: [] } },
    });
  });

  it("reports a plugin's missing tables before reading the server's data, and names db migrate", async () => {
    serverProject(database());

    await expect(doctor()).resolves.toEqual({
      success: false,
      details: expect.objectContaining({
        schema: {
          settings: [{ key: "schema.notes", expected: "1", found: null }],
          issues: [
            {
              type: "error",
              code: "SCHEMA_MIGRATION_PENDING",
              settings: [{ key: "schema.notes", expected: "1", found: null }],
              message:
                'The database has migrations to run before the server reads it: schema.notes is missing, expected "1".',
              resolution: `In the server's project, run \`${DB_MIGRATE}\`: it creates the missing tables and writes the settings rows. ${ORDER}: migrate it as you deploy the server of this release.`,
              commands: [DB_MIGRATE],
            },
          ],
        },
      }),
    });
    const result = await doctor();
    expect(result).not.toHaveProperty("details.releaseCatalogs");
  });

  it("reports core's stale schema with the plugins' missing tables in one run, and passes once db migrate's migrator ran", async () => {
    // What a database the previous minor release migrated records.
    await storeSetting("schema.core", "1.0.0");
    const configured = database();
    serverProject(configured);

    const pending = [
      { key: "schema.core", expected: "1.2.0", found: "1.0.0" },
      { key: "schema.notes", expected: "1", found: null },
    ];
    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          settings: pending,
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              message:
                'The database has migrations to run before the server reads it: schema.core is "1.0.0", expected "1.2.0"; schema.notes is missing, expected "1".',
              settings: pending,
              commands: [DB_MIGRATE],
            },
          ],
        },
      },
    });
    // Doctor only reports: the database is as it was.
    const [core] = await adapter.get(SETTINGS_TABLE, [["schema.core"]]);
    expect(core?.["value"]).toBe("1.0.0");

    // What `hot-updater db migrate` runs over the server's database and plugins.
    const migration = await createMigrator({
      database: configured,
      plugins: [notes],
    }).migrateToLatest({ updateSettings: true });
    await migration.execute();

    await expect(doctor()).resolves.not.toHaveProperty("details.schema");
  });

  it("names init with its saved inputs for a database hot-updater init manages", async () => {
    vi.stubEnv("HOT_UPDATER_INIT_PROVIDER", "cloudflare");
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID", "database");
    // A database the previous minor release's managed init created.
    await migrateCoreSchema(adapter, "d1Database", [
      insights(),
      apiKeys(),
      remoteConfig(),
    ]);
    await storeSetting("schema.core", "1.0.0");
    // The target d1Database marks for the database init saved.
    const target: Record<symbol, string> = {
      [Symbol.for("@hot-updater/database-target")]: "d1/database",
    };
    serverProject(
      { ...database("d1Database", { generateSchema: vi.fn() }), ...target },
      [insights(), apiKeys(), remoteConfig()],
    );

    const command = initReplayCommand("cloudflare");
    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              settings: [
                { key: "schema.core", expected: "1.2.0", found: "1.0.0" },
              ],
              resolution: `Run \`${command}\`: it applies the migrations this release needs, then redeploys the Worker from it, back to back. ${ORDER}, so run nothing in between.`,
              commands: [command],
            },
          ],
        },
      },
    });
  });

  it("names the database's own tooling when init's record names a provider whose database the config no longer uses", async () => {
    vi.stubEnv("HOT_UPDATER_INIT_PROVIDER", "aws");
    serverProject(
      database("d1Database", {
        generateSchema: vi.fn(),
        createMigrator: vi.fn(),
      }),
    );

    await expect(doctor()).resolves.toMatchObject({
      details: {
        schema: {
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              commands: [DB_GENERATE, DB_MIGRATE],
            },
          ],
        },
      },
    });
  });

  it("names db generate, the ORM, then db migrate for an ORM's tables", async () => {
    serverProject(
      database("drizzle", {
        generateSchema: vi.fn(),
        createMigrator: vi.fn(),
      }),
    );

    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              resolution: expect.stringContaining(
                `then run \`${DB_MIGRATE}\` to write the settings rows`,
              ),
              commands: [DB_GENERATE, DB_MIGRATE],
            },
          ],
        },
      },
    });
  });

  it("names db generate alone for a database whose migration file writes its settings rows", async () => {
    serverProject(
      database("supabaseDatabase", {
        generateSchema: vi.fn(),
        createMigrator: undefined,
      }),
    );

    await expect(doctor()).resolves.toMatchObject({
      details: {
        schema: {
          issues: [
            { code: "SCHEMA_MIGRATION_PENDING", commands: [DB_GENERATE] },
          ],
        },
      },
    });
  });

  it("names a SQL file for a database with no migration tooling", async () => {
    serverProject(database("memory", { createMigrator: undefined }));

    await expect(doctor()).resolves.toMatchObject({
      details: {
        schema: {
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              commands: ["npx hot-updater db generate --sql"],
            },
          ],
        },
      },
    });
  });

  it("reports a schema a newer release migrated, and names no migration", async () => {
    await storeSetting("schema.core", "9.0.0");
    serverProject(database());

    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          // The plugin's missing tables are listed, but a migration would
          // write core's setting back.
          settings: [
            { key: "schema.core", expected: "1.2.0", found: "9.0.0" },
            { key: "schema.notes", expected: "1", found: null },
          ],
          issues: [
            {
              code: "SCHEMA_NEWER_THAN_CLI",
              message:
                'The database was migrated by a newer hot-updater: schema.core is "9.0.0", expected "1.2.0".',
            },
          ],
        },
      },
    });
  });

  it("names no migration beside a plugin whose version changed, numeric or not", async () => {
    const later = definePlugin({
      id: "later",
      schemaVersion: "1",
      schema: {},
      init: () => ({ api: {} }),
    });
    await storeSetting("schema.later", "2");
    serverProject(database(), [notes, later] as never);

    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          settings: [
            { key: "schema.notes", expected: "1", found: null },
            { key: "schema.later", expected: "1", found: "2" },
          ],
          issues: [{ code: "PLUGIN_SCHEMA_CHANGED" }],
        },
      },
    });
  });

  it("leaves a plugin whose tables changed to its own migration, whatever its version labels", async () => {
    const labeled = definePlugin({
      id: "labeled",
      schemaVersion: "v2",
      schema: {},
      init: () => ({ api: {} }),
    });
    await migrateCoreSchema(adapter, "memory", [notes]);
    await storeSetting("schema.labeled", "v1");
    serverProject(database(), [notes, labeled] as never);

    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          issues: [
            {
              code: "PLUGIN_SCHEMA_CHANGED",
              message:
                'A plugin\'s version differs from the one the database recorded: schema.labeled is "v1", expected "v2".',
            },
          ],
        },
      },
    });
  });

  it("refuses a v0 database without naming a migration", async () => {
    adapter = createMemoryAdapter();
    // A v0 database's settings: its `version`, and no `schema.engine`, read
    // whole as the SQL and MongoDB adapters read them.
    await storeSetting("version", "0.21.0");
    const { dispose: _dispose, ...v0 } = createEngineDatabase({
      name: "memory",
      adapter,
      readSettings: async () => new Map([["version", "0.21.0"]]),
    });
    serverProject(v0);

    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          issues: [
            {
              code: "SCHEMA_NOT_MIGRATABLE",
              message:
                "The database is a Hot Updater v0 database, schema 0.21.0.",
            },
          ],
        },
      },
    });
  });

  it("refuses a setting whose version it cannot compare", async () => {
    await storeSetting("schema.core", "next");
    serverProject(database());

    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        schema: { issues: [{ code: "SCHEMA_NOT_MIGRATABLE" }] },
      },
    });
  });
});
