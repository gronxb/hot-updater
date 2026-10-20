import { loadConfig, readPackageUp } from "@hot-updater/cli-tools";
import {
  type AnyHotUpdaterPlugin,
  createEngine,
  createEngineDatabase,
  createMemoryAdapter,
  type DatabaseAdapter,
  definePlugin,
  defineTable,
  migrateCoreSchema,
  SETTINGS_TABLE,
  type ToolingDatabase,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiKeys, insights, remoteConfig, vault } from "../plugins";
import { loadServer } from "../utils/loadServer";
import { testServer } from "../utils/testServer";
import { doctor } from "./doctor";
import { INIT_PROVIDER_PACKAGES } from "./initProviders";

vi.mock("../packageJson", () => ({ packageJsonData: { version: "1.0.0" } }));

vi.mock("../utils/loadServer", () => ({ loadServer: vi.fn() }));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(() => "/project"),
  loadConfig: vi.fn(),
  readPackageUp: vi.fn(),
}));

/** A plugin a later release adds to the managed database, as vault() does. */
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

describe("doctor's schema check", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = createMemoryAdapter();
    // Core's tables, as an earlier release's init created them.
    await migrateCoreSchema(adapter, "memory");
  });

  it("passes when the fence does", async () => {
    await migrateCoreSchema(adapter, "memory", [notes]);
    serverProject(database());

    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: { releaseCatalogs: { issues: [] } },
    });
  });

  it("reports a plugin's missing tables before reading the server's data", async () => {
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
              resolution:
                "Run `npx hot-updater doctor --fix` to create the missing tables and write the settings rows.",
              fixability: "command",
              commands: ["npx hot-updater doctor --fix"],
            },
          ],
        },
      }),
    });
    const result = await doctor();
    expect(result).not.toHaveProperty("details.releaseCatalogs");
  });

  it("migrates the database with --fix, then checks its data", async () => {
    serverProject(database());

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: true,
      details: {
        fixes: [
          {
            repair: "schema",
            codes: ["SCHEMA_MIGRATION_PENDING"],
            status: "applied",
            wrote: ["schema.notes 1"],
          },
        ],
        releaseCatalogs: { issues: [] },
      },
    });
    await expect(doctor()).resolves.not.toHaveProperty("details.schema");
  });

  it("repairs what the migration lets it see, in the same run", async () => {
    // A release whose catalog differs from it, behind the plugin's fence.
    const { core } = createHotUpdater({
      database: database(),
      storage: createReleaseCatalogTestStorage(),
      clientAccess: "public",
    });
    const [deployed] = await core.deploy([
      {
        bundle: {
          assetBaseStorageUri: "storage://assets",
          gitCommitHash: null,
          id: "01900000-0000-7000-8000-000000000001",
          manifestFileHash: "manifest-hash-1",
          manifestStorageUri: "storage://artifacts/1/manifest.json",
          metadata: {},
          platform: "ios",
        },
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "1.0.x",
        },
      },
    ]);
    const scopeKey = deployed!.release!.scope_key;
    const engine = createEngine(database());
    await engine.core.transaction(async (tx) => {
      const row = await tx.findOne("release_catalogs", {
        scope_key: scopeKey,
      });
      tx.update("release_catalogs", row!, {
        catalog_hash: `sha256:${"0".repeat(64)}`,
      });
    });
    await engine.dispose();
    serverProject(database());

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: true,
      details: {
        fixes: [
          { repair: "schema", status: "applied" },
          {
            repair: "release-catalogs",
            status: "applied",
            wrote: [`release catalog ${scopeKey}, generation 2`],
          },
        ],
        releaseCatalogs: { scopes: [{ scopeKey, state: "verified" }] },
      },
    });
  });

  it("migrates the vault's tables beside the managed plugins' with --fix, as a KV or Postgres database needs", async () => {
    // A database an earlier release initialized for the managed plugins.
    await migrateCoreSchema(adapter, "memory", [
      insights(),
      apiKeys(),
      remoteConfig(),
    ]);
    serverProject(database(), [insights(), apiKeys(), remoteConfig(), vault()]);

    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              settings: [
                { key: "schema.vault", expected: "1.0.0", found: null },
              ],
            },
          ],
        },
      },
    });
    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: true,
      details: {
        fixes: [
          {
            repair: "schema",
            codes: ["SCHEMA_MIGRATION_PENDING"],
            status: "applied",
            wrote: ["schema.vault 1.0.0"],
          },
        ],
      },
    });
    await expect(doctor()).resolves.not.toHaveProperty("details.schema");
  });

  it("reports core's stale schema first, and --fix migrates core and the plugins", async () => {
    // What a database the previous minor release migrated records.
    await storeSetting("schema.core", "1.0.0");
    serverProject(database());

    await expect(doctor()).resolves.toMatchObject({
      details: {
        schema: {
          settings: [{ key: "schema.core", expected: "1.2.0", found: "1.0.0" }],
        },
      },
    });
    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: true,
      details: { fixes: [{ repair: "schema", status: "applied" }] },
    });
    const [row] = await adapter.get(SETTINGS_TABLE, [["schema.core"]]);
    expect(row?.["value"]).toBe("1.2.0");
  });

  it("refuses to move a schema a newer release migrated back", async () => {
    await storeSetting("schema.core", "9.0.0");
    serverProject(database());

    const result = await doctor({ fix: true });
    expect(result).toMatchObject({
      success: false,
      details: {
        schema: {
          issues: [
            {
              code: "SCHEMA_NEWER_THAN_CLI",
              fixability: "blocked",
              message:
                'The database was migrated by a newer hot-updater: schema.core is "9.0.0", expected "1.2.0".',
            },
          ],
        },
        fixes: [],
      },
    });
    const [row] = await adapter.get(SETTINGS_TABLE, [["schema.core"]]);
    expect(row?.["value"]).toBe("9.0.0");
  });

  it("offers no migration while a newer release's setting would move back", async () => {
    await storeSetting("schema.core", "9.0.0");
    serverProject(database());

    const result = await doctor({ fix: true });
    expect(result).toMatchObject({
      success: false,
      details: {
        schema: {
          settings: [{ key: "schema.core", expected: "1.2.0", found: "9.0.0" }],
          issues: [{ code: "SCHEMA_NEWER_THAN_CLI" }],
        },
        fixes: [],
      },
    });
  });

  it("offers no migration beside a plugin whose version changed, numeric or not", async () => {
    const later = definePlugin({
      id: "later",
      schemaVersion: "1",
      schema: {},
      init: () => ({ api: {} }),
    });
    await migrateCoreSchema(adapter, "memory");
    await storeSetting("schema.later", "2");
    serverProject(database(), [notes, later] as never);

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          settings: [
            { key: "schema.notes", expected: "1", found: null },
            { key: "schema.later", expected: "1", found: "2" },
          ],
          issues: [{ code: "PLUGIN_SCHEMA_CHANGED" }],
        },
        fixes: [],
      },
    });
    const [row] = await adapter.get(SETTINGS_TABLE, [["schema.later"]]);
    expect(row?.["value"]).toBe("2");
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

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          issues: [
            {
              code: "PLUGIN_SCHEMA_CHANGED",
              fixability: "blocked",
              message:
                'A plugin\'s version differs from the one the database recorded: schema.labeled is "v1", expected "v2".',
            },
          ],
        },
        fixes: [],
      },
    });
    const [row] = await adapter.get(SETTINGS_TABLE, [["schema.labeled"]]);
    expect(row?.["value"]).toBe("v1");
  });

  it("runs a managed provider's migration files through its init", async () => {
    const migrateDatabase = vi.fn(async () => {
      // What the provider's migrations do on this database.
      await migrateCoreSchema(adapter, "d1Database", [notes]);
      return { applied: ["0002_hot-updater_1.2.0.sql"] };
    });
    vi.spyOn(INIT_PROVIDER_PACKAGES.cloudflare, "load").mockResolvedValue({
      migrateDatabase,
    } as never);
    serverProject(database("d1Database", { generateSchema: vi.fn() }));

    await expect(doctor()).resolves.toMatchObject({
      details: {
        schema: {
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              resolution:
                "Run `npx hot-updater doctor --fix` to apply the provider's migrations this database has not run. They create core's tables and the official plugins'.",
            },
          ],
        },
      },
    });
    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: true,
      details: {
        fixes: [
          {
            repair: "schema",
            status: "applied",
            wrote: ["migration 0002_hot-updater_1.2.0.sql"],
          },
        ],
      },
    });
    expect(migrateDatabase).toHaveBeenCalledWith({
      cwd: "/project",
      database: expect.objectContaining({ name: "d1Database" }),
      nonInteractive: expect.any(Boolean),
    });
  });

  it("migrates a D1 database the managed init did not create through its migrator", async () => {
    vi.spyOn(INIT_PROVIDER_PACKAGES.cloudflare, "load").mockResolvedValue({
      migrateDatabase: async () => ({
        skip: "The D1 database has no record of 0001_hot-updater_1.0.0.sql.",
        unmanaged: true,
      }),
    } as never);
    serverProject(database("d1Database", { generateSchema: vi.fn() }));

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: true,
      details: {
        fixes: [
          { repair: "schema", status: "applied", wrote: ["schema.notes 1"] },
        ],
      },
    });
  });

  it("creates on a managed D1 database the tables of a plugin its migrations do not cover", async () => {
    vi.spyOn(INIT_PROVIDER_PACKAGES.cloudflare, "load").mockResolvedValue({
      migrateDatabase: async () => ({ applied: [] }),
    } as never);
    serverProject(database("d1Database", { generateSchema: vi.fn() }));

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: true,
      details: {
        fixes: [
          { repair: "schema", status: "applied", wrote: ["schema.notes 1"] },
        ],
      },
    });
  });

  it("names the plugins a managed Supabase project's migrations do not cover", async () => {
    vi.spyOn(INIT_PROVIDER_PACKAGES.supabase, "load").mockResolvedValue({
      migrateDatabase: async () => ({ applied: [] }),
    } as never);
    serverProject(
      database("supabaseDatabase", {
        generateSchema: vi.fn(),
        createMigrator: undefined,
      }),
    );

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: false,
      details: {
        fixes: [
          {
            repair: "schema",
            status: "skipped",
            note: expect.stringContaining(
              "schema.notes belongs to a plugin they do not create",
            ),
          },
        ],
      },
    });
  });

  it("refuses a v0 database without offering a repair", async () => {
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

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          issues: [
            {
              code: "SCHEMA_NOT_MIGRATABLE",
              message:
                "The database is a Hot Updater v0 database, schema 0.21.0.",
              fixability: "blocked",
            },
          ],
        },
        fixes: [],
      },
    });
  });

  it("names what a managed Supabase project's migrations left for other plugins", async () => {
    vi.spyOn(INIT_PROVIDER_PACKAGES.supabase, "load").mockResolvedValue({
      migrateDatabase: async () => ({
        applied: ["0002_hot-updater_1.2.0.sql"],
      }),
    } as never);
    serverProject(
      database("supabaseDatabase", {
        generateSchema: vi.fn(),
        createMigrator: undefined,
      }),
    );

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: false,
      details: {
        fixes: [
          {
            repair: "schema",
            status: "applied",
            wrote: ["migration 0002_hot-updater_1.2.0.sql"],
            note: expect.stringContaining(
              "schema.notes belongs to a plugin they do not create",
            ),
          },
        ],
        schema: { issues: [{ code: "SCHEMA_MIGRATION_PENDING" }] },
      },
    });
  });

  it("refuses a setting whose version it cannot compare", async () => {
    await storeSetting("schema.core", "next");
    serverProject(database());

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: false,
      details: {
        schema: {
          issues: [{ code: "SCHEMA_NOT_MIGRATABLE", fixability: "blocked" }],
        },
        fixes: [],
      },
    });
  });

  it("names the provider's reason when its init applies nothing", async () => {
    vi.spyOn(INIT_PROVIDER_PACKAGES.supabase, "load").mockResolvedValue({
      migrateDatabase: async () => ({ skip: "Set the database password." }),
    } as never);
    serverProject(database("supabaseDatabase", { generateSchema: vi.fn() }));

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: false,
      details: {
        fixes: [
          {
            repair: "schema",
            status: "skipped",
            note: "Set the database password.",
          },
        ],
        schema: { issues: [{ code: "SCHEMA_MIGRATION_PENDING" }] },
      },
    });
  });

  it("leaves an ORM's tables to the ORM, and writes no settings row", async () => {
    serverProject(
      database("drizzle", {
        generateSchema: vi.fn(),
        createMigrator: vi.fn(),
      }),
    );

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: false,
      details: {
        fixes: [
          {
            repair: "schema",
            status: "skipped",
            note: expect.stringContaining("npx hot-updater db generate"),
          },
        ],
        schema: {
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              fixability: "command",
              commands: [
                "npx hot-updater db generate",
                "npx hot-updater db migrate",
              ],
            },
          ],
        },
      },
    });
  });
});
