import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { loadConfig, readPackageUp } from "@hot-updater/cli-tools";
import { d1Database } from "@hot-updater/cloudflare";
import {
  type AnyHotUpdaterPlugin,
  type ConfiguredDatabase,
  createEngineDatabase,
  createMemoryAdapter,
  createSqlAdapter,
  createStorageAdapter,
  type DatabaseAdapter,
  migrateCoreSchema,
  SETTINGS_TABLE,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { pgliteExecutor } from "@hot-updater/test-utils/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiKeys, insights, remoteConfig } from "../plugins";
import { doctor } from "./doctor";
import {
  INIT_PROVIDER_PACKAGES,
  type InitProvider,
  initReplayCommand,
} from "./initProviders";

// The CLI of the release whose core schema is 1.2.0.
vi.mock("../packageJson", () => ({ packageJsonData: { version: "1.2.0" } }));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  readPackageUp: vi.fn(),
}));

const CLOUDFLARE_PACKAGE = path.resolve(
  import.meta.dirname,
  "../../../../plugins/cloudflare",
);

/** The plugins every managed server runs, as init writes them into the config. */
const managedPlugins = (): AnyHotUpdaterPlugin[] => [
  insights(),
  apiKeys(),
  remoteConfig(),
];

const SERVER = "https://updates.example.com";

/** The release the server at SERVER runs: 1.1.3 until it is redeployed. */
let deployed: string;
const fetchVersion = vi.fn<typeof fetch>(async () =>
  Response.json({ infrastructureGeneration: 1, version: deployed }),
);

let cwd: string;

/**
 * The app project: hot-updater.config.ts names `database` and the managed
 * plugins, and `.env.hotupdater` records the provider init ran, when it did.
 */
const project = async (
  database: ConfiguredDatabase,
  provider: InitProvider | null,
) => {
  if (provider !== null) {
    await writeFile(
      path.join(cwd, ".env.hotupdater"),
      `HOT_UPDATER_INIT_BUILD=bare\nHOT_UPDATER_INIT_PROVIDER=${provider}\n`,
    );
  }
  vi.mocked(readPackageUp).mockResolvedValue({
    packageJson: { devDependencies: { "hot-updater": "1.2.0" } },
    path: path.join(cwd, "package.json"),
  } as never);
  // Doctor closes the database after each run; these specs read it across
  // runs. Every property is kept, d1Database's D1 target among them.
  const { dispose: _dispose, ...kept } = Object.getOwnPropertyDescriptors(
    database,
  ) as Record<string, PropertyDescriptor>;
  const configured = Object.defineProperties({}, kept);
  vi.mocked(loadConfig).mockResolvedValue({
    database: configured,
    storage: createStorageAdapter({ name: "none", protocol: "none" }),
    plugins: managedPlugins(),
  } as never);
};

const run = (options: { fix?: boolean; serverBaseUrl?: string } = {}) =>
  doctor({ cwd, fetch: fetchVersion, nonInteractive: true, ...options });

/** Sets a settings row, as an earlier release's migration left it. */
const storeSetting = async (
  adapter: DatabaseAdapter,
  key: string,
  value: string,
) => {
  const [row] = await adapter.get(SETTINGS_TABLE, [[key]]);
  await adapter.write([
    {
      type: "patch",
      table: SETTINGS_TABLE,
      key: [key],
      set: { value },
      guard: { v: Number(row!["_v"]) },
      previous: row!,
    },
  ]);
};

const PENDING = [{ key: "schema.core", expected: "1.2.0", found: "1.0.0" }];

/**
 * Upgrades a 1.1.3 deployment as the 1.2.0 upgrade guide does, and checks
 * each doctor run on the way: doctor names the replay of init for both the
 * database and the server, `--fix` leaves the database alone while the
 * server of 1.1.3 still reads it, migrates it once the server runs 1.2.0,
 * and doctor then comes back clean.
 */
const upgrade = async (provider: InitProvider, migrated: readonly string[]) => {
  const command = initReplayCommand(provider);
  const { server } = INIT_PROVIDER_PACKAGES[provider];

  await expect(run({ serverBaseUrl: SERVER })).resolves.toMatchObject({
    success: false,
    details: {
      infrastructure: {
        serverVersion: "1.1.3",
        requiredVersion: "1.2.0",
        needsUpdate: true,
        remediation: { commands: [command] },
      },
      schema: {
        settings: PENDING,
        issues: [
          {
            code: "SCHEMA_MIGRATION_PENDING",
            settings: PENDING,
            commands: [command],
            resolution: expect.stringContaining(
              `Run \`${command}\`: it applies this migration and redeploys ${server} from this release in one run`,
            ),
            waitsForServer: expect.stringContaining(
              `The server at ${SERVER} runs 1.1.3, which answers 503 once this database is migrated.`,
            ),
          },
        ],
      },
    },
  });

  // Without the server's URL, doctor cannot see which release reads the database.
  await expect(run({ fix: true })).resolves.toMatchObject({
    success: false,
    details: {
      fixes: [
        {
          repair: "schema",
          status: "skipped",
          note: expect.stringContaining(
            `doctor cannot see that ${server} runs 1.2.0+ without --server-base-url`,
          ),
        },
      ],
    },
  });
  await expect(
    run({ fix: true, serverBaseUrl: SERVER }),
  ).resolves.toMatchObject({
    success: false,
    details: {
      fixes: [
        {
          repair: "schema",
          status: "skipped",
          note: expect.stringContaining(`Run \`${command}\``),
        },
      ],
      schema: { settings: PENDING },
    },
  });

  // The server of 1.2.0 is deployed, and answers 503 until the migration.
  deployed = "1.2.0";
  await expect(
    run({ fix: true, serverBaseUrl: SERVER }),
  ).resolves.toMatchObject({
    success: true,
    details: {
      fixes: [{ repair: "schema", status: "applied", wrote: migrated }],
    },
  });

  const clean = await run({ serverBaseUrl: SERVER });
  expect(clean).toMatchObject({
    success: true,
    details: {
      infrastructure: { serverVersion: "1.2.0", needsUpdate: false },
      releaseCatalogs: { issues: [] },
    },
  });
  expect(clean).not.toHaveProperty("details.schema");
  expect(clean).not.toHaveProperty("details.infrastructure.remediation");
};

/**
 * D1's REST API (`/accounts/:account/d1/database/:id/query`) over a SQLite
 * database: a statement, or a batch D1 runs in one transaction.
 */
const d1Api = (db: DatabaseSync): Promise<Server> => {
  const execute = ({
    sql,
    params = [],
  }: {
    sql: string;
    params?: SqliteValue[];
  }) => {
    const statement = db.prepare(sql);
    if (statement.columns().length > 0) {
      return { results: statement.all(...params), success: true, meta: {} };
    }
    const { changes } = statement.run(...params);
    return { results: [], success: true, meta: { changes: Number(changes) } };
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { batch, ...single } = JSON.parse(body);
    const statements = batch ?? [single];
    db.exec("BEGIN");
    try {
      const result = statements.map(execute);
      db.exec("COMMIT");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ success: true, errors: [], messages: [], result }),
      );
    } catch (error) {
      db.exec("ROLLBACK");
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          success: false,
          errors: [{ code: 7500, message: `${String(error)}: SQLITE_ERROR` }],
          messages: [],
          result: null,
        }),
      );
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
};

/** The schema SQLite keeps for Hot Updater's tables and indexes, by name. */
const sqliteSchema = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
    )
    .all();

const sqliteSettings = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT "key", "value" FROM "${SETTINGS_TABLE.name}" ORDER BY "key"`,
    )
    .all();

describe("doctor on a 1.1.3 deployment upgraded to 1.2.0", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    deployed = "1.1.3";
    cwd = await mkdtemp(path.join(tmpdir(), "hot-updater-upgrade-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it("migrates a managed D1 database with the Worker's 0002 migration once the Worker runs 1.2.0", async () => {
    // What 1.1.3's managed init left: wrangler's record of the one migration
    // that release shipped, and its tables.
    const sqlite = new DatabaseSync(":memory:");
    const migrations = path.join(CLOUDFLARE_PACKAGE, "worker", "migrations");
    sqlite.exec(
      "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    );
    sqlite.exec(
      await readFile(
        path.join(migrations, "0001_hot-updater_1.0.0.sql"),
        "utf8",
      ),
    );
    sqlite
      .prepare("INSERT INTO d1_migrations (name) VALUES (?)")
      .run("0001_hot-updater_1.0.0.sql");
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name LIKE 'native_builds%'",
        )
        .all(),
    ).toEqual([]);

    const api = await d1Api(sqlite);
    try {
      vi.stubEnv(
        "CLOUDFLARE_BASE_URL",
        `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      );
      // The provider's init loads from the app's node_modules.
      await mkdir(path.join(cwd, "node_modules", "@hot-updater"), {
        recursive: true,
      });
      await symlink(
        CLOUDFLARE_PACKAGE,
        path.join(cwd, "node_modules", "@hot-updater", "cloudflare"),
      );
      const config = {
        accountId: "account",
        databaseId: "database",
        cloudflareApiToken: "token",
      };
      await project(d1Database(config), "cloudflare");

      await upgrade("cloudflare", ["migration 0002_hot-updater_1.2.0.sql"]);

      // The upgraded database is what this release's init creates: every
      // table, column, and index, native_builds' among them, and every
      // settings row.
      const fresh = new DatabaseSync(":memory:");
      fresh.exec(
        d1Database(config).generateSchema!(
          "latest",
          "d1Database",
          toolingTargetOf(managedPlugins()),
        ).code,
      );
      expect(sqliteSchema(sqlite)).toEqual(sqliteSchema(fresh));
      expect(
        sqlite.prepare("PRAGMA table_info('native_builds')").all(),
      ).toEqual(fresh.prepare("PRAGMA table_info('native_builds')").all());
      expect(
        sqlite
          .prepare("PRAGMA table_info('native_builds')")
          .all()
          .map(({ name }) => name),
      ).toEqual(expect.arrayContaining(["id", "scope_key", "build_key"]));
      expect(
        sqlite.prepare("PRAGMA index_list('native_builds')").all(),
      ).toEqual(fresh.prepare("PRAGMA index_list('native_builds')").all());
      expect(sqliteSettings(sqlite)).toEqual(sqliteSettings(fresh));
      expect(sqliteSettings(sqlite)).toContainEqual({
        key: "schema.core",
        value: "1.2.0",
      });
      expect(
        sqlite.prepare("SELECT name FROM d1_migrations ORDER BY id").all(),
      ).toEqual([
        { name: "0001_hot-updater_1.0.0.sql" },
        { name: "0002_hot-updater_1.2.0.sql" },
      ]);
    } finally {
      await new Promise((resolve) => api.close(resolve));
    }
  });

  it("migrates a managed Vercel PostgreSQL database once the Function runs 1.2.0", async () => {
    const pglite = new PGlite();
    const adapter = createSqlAdapter({ executor: pgliteExecutor(pglite) });
    // 1.1.3's schema: core 1.0.0, before the native build registry.
    await migrateCoreSchema(adapter, "postgres", managedPlugins());
    await pglite.exec('DROP TABLE "native_builds"');
    await storeSetting(adapter, "schema.core", "1.0.0");
    await project(
      createEngineDatabase({ name: "postgres", adapter }),
      "vercel",
    );

    await upgrade("vercel", ["schema.core 1.2.0"]);

    // What this release's init creates on an empty database.
    const fresh = new PGlite();
    await migrateCoreSchema(
      createSqlAdapter({ executor: pgliteExecutor(fresh) }),
      "postgres",
      managedPlugins(),
    );
    const shape = async (db: PGlite) => ({
      columns: (
        await db.query(
          "SELECT table_name, column_name, data_type, is_nullable, collation_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
        )
      ).rows,
      indexes: (
        await db.query(
          "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname",
        )
      ).rows,
      settings: (
        await db.query(
          `SELECT "key", "value" FROM "${SETTINGS_TABLE.name}" ORDER BY "key"`,
        )
      ).rows,
    });
    const upgraded = await shape(pglite);
    expect(upgraded).toEqual(await shape(fresh));
    expect(upgraded.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tablename: "native_builds" }),
      ]),
    );
    expect(upgraded.settings).toContainEqual({
      key: "schema.core",
      value: "1.2.0",
    });
  });

  it.each<InitProvider>(["aws", "firebase", "azure"])(
    "writes the settings rows of a managed %s database once its server runs 1.2.0",
    async (provider) => {
      const adapter = createMemoryAdapter();
      const name = INIT_PROVIDER_PACKAGES[provider].database;
      await migrateCoreSchema(adapter, name, managedPlugins());
      await storeSetting(adapter, "schema.core", "1.0.0");
      await project(createEngineDatabase({ name, adapter }), provider);

      await upgrade(provider, ["schema.core 1.2.0"]);

      const [core] = await adapter.get(SETTINGS_TABLE, [["schema.core"]]);
      expect(core).toMatchObject({ value: "1.2.0" });
    },
  );

  it("pushes the Supabase migrations once the Edge Function runs 1.2.0", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "supabaseDatabase", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    const migrateDatabase = vi.fn(async () => {
      // What `supabase db push` of 0002 does on this database.
      await migrateCoreSchema(adapter, "supabaseDatabase", managedPlugins());
      return { applied: ["0002_hot-updater_1.2.0.sql"] };
    });
    vi.spyOn(INIT_PROVIDER_PACKAGES.supabase, "load").mockResolvedValue({
      migrateDatabase,
    } as never);
    await project(
      createEngineDatabase({ name: "supabaseDatabase", adapter }),
      "supabase",
    );

    await upgrade("supabase", ["migration 0002_hot-updater_1.2.0.sql"]);
    expect(migrateDatabase).toHaveBeenCalledOnce();
  });

  describe("a server of the project's own", () => {
    const ownServer = async () => {
      const adapter = createMemoryAdapter();
      await migrateCoreSchema(adapter, "kysely", managedPlugins());
      await storeSetting(adapter, "schema.core", "1.0.0");
      // A project whose init record names a provider whose database it left.
      await project(
        createEngineDatabase({ name: "kysely", adapter }),
        "cloudflare",
      );
      return adapter;
    };

    it("migrates with --fix, and says to deploy the server with the migration", async () => {
      await ownServer();

      await expect(run()).resolves.toMatchObject({
        details: {
          schema: {
            issues: [
              {
                code: "SCHEMA_MIGRATION_PENDING",
                commands: ["npx hot-updater doctor --fix"],
                resolution:
                  "Run `npx hot-updater doctor --fix` to create the missing tables and write the settings rows. A server of an earlier release answers 503 once the database is migrated, and a server of this release answers 503 until it is: migrate it as you deploy the server from this release.",
              },
            ],
          },
        },
      });
      await expect(run({ fix: true })).resolves.toMatchObject({
        success: true,
        details: {
          fixes: [
            { repair: "schema", status: "applied", wrote: PENDING_WROTE },
          ],
        },
      });
    });

    it("leaves the database alone while the server it is shown runs an earlier release", async () => {
      await ownServer();

      await expect(
        run({ fix: true, serverBaseUrl: SERVER }),
      ).resolves.toMatchObject({
        success: false,
        details: {
          infrastructure: {
            needsUpdate: true,
            remediation: {
              commands: [
                "npx hot-updater db migrate",
                "npx hot-updater db generate",
                "hot-updater agent infra upgrade",
              ],
            },
          },
          fixes: [
            {
              repair: "schema",
              status: "skipped",
              note: `The server at ${SERVER} runs 1.1.3, which answers 503 once this database is migrated. Deploy the server from @hot-updater/server 1.2.0+ first, then rerun \`npx hot-updater doctor --fix --server-base-url ${SERVER}\`, or run \`npx hot-updater db migrate\` in the server's project as it deploys.`,
            },
          ],
        },
      });

      deployed = "1.2.0";
      await expect(
        run({ fix: true, serverBaseUrl: SERVER }),
      ).resolves.toMatchObject({
        success: true,
        details: {
          fixes: [
            { repair: "schema", status: "applied", wrote: PENDING_WROTE },
          ],
        },
      });
    });
  });
});

const PENDING_WROTE = ["schema.core 1.2.0"];
