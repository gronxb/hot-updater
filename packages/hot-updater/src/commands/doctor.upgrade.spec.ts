import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import {
  createMigrator,
  loadConfig,
  readPackageUp,
} from "@hot-updater/cli-tools";
import { d1Database } from "@hot-updater/cloudflare";
import {
  type AnyHotUpdaterPlugin,
  createEngineDatabase,
  createMemoryAdapter,
  createSqlAdapter,
  createStorageAdapter,
  type DatabaseAdapter,
  definePlugin,
  migrateCoreSchema,
  SETTINGS_TABLE,
  type ToolingDatabase,
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

/** The CLI's version and the server package it bundles: 1.2.0's, or its release candidate's. */
const versions = vi.hoisted(() => ({ cli: "1.2.0", server: "1.2.0" }));

vi.mock("../packageJson", () => ({
  packageJsonData: {
    get version() {
      return versions.cli;
    },
  },
}));

vi.mock("@hot-updater/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/server")>()),
  get HOT_UPDATER_SERVER_VERSION() {
    return versions.server;
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
  readPackageUp: vi.fn(),
}));

const D1_MIGRATIONS = path.resolve(
  import.meta.dirname,
  "../../../../plugins/cloudflare/worker/migrations",
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

/** The key every provider's database factory marks its resource under. */
const DATABASE_TARGET = Symbol.for("@hot-updater/database-target");

/**
 * Each provider's saved inputs that name its database, and the target its
 * database factory marks for that database.
 */
const SAVED: Record<
  InitProvider,
  { readonly env: Record<string, string>; readonly target: string }
> = {
  cloudflare: {
    env: { HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: "database" },
    target: "d1/database",
  },
  supabase: {
    env: { HOT_UPDATER_SUPABASE_PROJECT_ID: "ref" },
    target: "supabase/ref.supabase.co",
  },
  aws: {
    env: { HOT_UPDATER_DYNAMODB_TABLE_NAME: "hot-updater" },
    target: "dynamodb/hot-updater",
  },
  firebase: {
    env: { HOT_UPDATER_FIREBASE_PROJECT_ID: "app" },
    target: "firestore/app/(default)",
  },
  vercel: {
    env: {
      HOT_UPDATER_VERCEL_DATABASE_URL:
        "postgres://user:secret@db.example.com:5432/app",
    },
    target: "postgres/db.example.com:5432/app",
  },
  azure: {
    env: { HOT_UPDATER_AZURE_COSMOS_ACCOUNT: "account" },
    target: "cosmos/account.documents.azure.com",
  },
};

/** `database` marked as its provider's factory marks the database init saved. */
const marked = <T extends object>(database: T, provider: InitProvider): T => ({
  ...database,
  [DATABASE_TARGET]: SAVED[provider].target,
});

/**
 * The app project: hot-updater.config.ts names `database` and the managed
 * plugins, and `.env.hotupdater` records the provider init ran, when it did.
 */
const project = async (
  database: ToolingDatabase,
  provider: InitProvider | null,
  saved: Record<string, string> = provider === null ? {} : SAVED[provider].env,
) => {
  if (provider !== null) {
    await writeFile(
      path.join(cwd, ".env.hotupdater"),
      Object.entries({
        HOT_UPDATER_INIT_BUILD: "bare",
        HOT_UPDATER_INIT_PROVIDER: provider,
        ...saved,
      })
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
  vi.mocked(readPackageUp).mockResolvedValue({
    packageJson: { devDependencies: { "hot-updater": "1.2.0" } },
    path: path.join(cwd, "package.json"),
  } as never);
  // Doctor closes the database after each run; these specs read it across runs.
  const { dispose: _dispose, ...kept } = database;
  vi.mocked(loadConfig).mockResolvedValue({
    database: kept,
    storage: createStorageAdapter({ name: "none", protocol: "none" }),
    plugins: managedPlugins(),
  } as never);
  return kept;
};

const run = () => doctor({ cwd, fetch: fetchVersion, serverBaseUrl: SERVER });

/** Each provider's scaffold resources for the database SAVED names. */
const SCAFFOLD_RESOURCES: Record<InitProvider, Record<string, string>> = {
  cloudflare: { d1DatabaseId: "database" },
  supabase: { projectId: "ref" },
  aws: { tableName: "hot-updater" },
  firebase: { projectId: "app" },
  vercel: {},
  azure: { cosmosAccount: "account" },
};

/**
 * The deployment record an agent infrastructure scaffold keeps in the CLI's
 * default output, `hot-updater-infra/<provider>/<name>`.
 */
const scaffold = async (
  provider: InitProvider,
  name: string,
  baseUrl: string | null,
  build = "bare",
  resources: Record<string, string> = SCAFFOLD_RESOURCES[provider],
) => {
  const dir = path.join(cwd, "hot-updater-infra", provider, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      provider,
      operation: "upgrade",
      build,
      files: {},
    }),
  );
  await writeFile(
    path.join(dir, "deployment.json"),
    JSON.stringify({
      schemaVersion: 1,
      provider,
      resources,
      baseUrl,
      pendingStep: null,
      verifiedSteps: [],
    }),
  );
};

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

/**
 * What a provider's init writes into the database when it runs again: the
 * migrator over the managed plugins, as `migratePostgres`, `migrateDynamoDB`,
 * `migrateFirebaseDatabase` and `migrateCosmosDatabase` run it, which is also
 * what `hot-updater db migrate` runs.
 */
const migrate = async (database: ToolingDatabase) => {
  const migration = await createMigrator({
    database,
    plugins: managedPlugins(),
  }).migrateToLatest({ updateSettings: true });
  await migration.execute();
};

const PENDING = [{ key: "schema.core", expected: "1.2.0", found: "1.0.0" }];

/**
 * Upgrades a 1.1.3 deployment as doctor says: doctor names init with its
 * saved inputs for both the database and the server; `runInitMigration` does
 * what that init does to the database, then the server of 1.2.0 is deployed,
 * and doctor comes back clean.
 */
const upgrade = async (
  provider: InitProvider,
  runInitMigration: () => Promise<void>,
) => {
  const command = initReplayCommand(provider);
  const { server } = INIT_PROVIDER_PACKAGES[provider];

  await expect(run()).resolves.toMatchObject({
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
              `Run \`${command}\`: it applies the migrations this release needs, then redeploys ${server} from it, back to back.`,
            ),
          },
        ],
      },
    },
  });

  // What the named init does: the migration, then the server, back to back.
  await runInitMigration();
  deployed = "1.2.0";

  const clean = await run();
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

/**
 * `wrangler d1 migrations apply`, which init runs again: each migration file
 * `d1_migrations` does not record, in order, recorded by name.
 */
const wranglerMigrationsApply = async (db: DatabaseSync) => {
  const ran = new Set(
    db
      .prepare("SELECT name FROM d1_migrations")
      .all()
      .map(({ name }) => String(name)),
  );
  for (const name of (await readdir(D1_MIGRATIONS)).sort()) {
    if (!name.endsWith(".sql") || ran.has(name)) continue;
    db.exec(await readFile(path.join(D1_MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
  }
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
    versions.cli = "1.2.0";
    versions.server = "1.2.0";
    cwd = await mkdtemp(path.join(tmpdir(), "hot-updater-upgrade-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it("names init for a managed D1 database, whose Worker migrations bring it to 1.2.0", async () => {
    // What 1.1.3's managed init left: wrangler's record of the one migration
    // that release shipped, and its tables.
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    );
    sqlite.exec(
      await readFile(
        path.join(D1_MIGRATIONS, "0001_hot-updater_1.0.0.sql"),
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
      const config = {
        accountId: "account",
        databaseId: "database",
        cloudflareApiToken: "token",
      };
      await project(d1Database(config), "cloudflare");

      await upgrade("cloudflare", () => wranglerMigrationsApply(sqlite));

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

  it("names init for a managed Vercel PostgreSQL database, whose migrator brings it to 1.2.0", async () => {
    const pglite = new PGlite();
    const adapter = createSqlAdapter({ executor: pgliteExecutor(pglite) });
    // 1.1.3's schema: core 1.0.0, before the native build registry.
    await migrateCoreSchema(adapter, "postgres", managedPlugins());
    await pglite.exec('DROP TABLE "native_builds"');
    await storeSetting(adapter, "schema.core", "1.0.0");
    const database = await project(
      marked(createEngineDatabase({ name: "postgres", adapter }), "vercel"),
      "vercel",
    );

    await upgrade("vercel", () => migrate(database));

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
    "names init for a managed %s database, whose migrator writes its settings rows",
    async (provider) => {
      const adapter = createMemoryAdapter();
      const name = INIT_PROVIDER_PACKAGES[provider].database;
      await migrateCoreSchema(adapter, name, managedPlugins());
      await storeSetting(adapter, "schema.core", "1.0.0");
      const database = await project(
        marked(createEngineDatabase({ name, adapter }), provider),
        provider,
      );

      await upgrade(provider, () => migrate(database));

      const [core] = await adapter.get(SETTINGS_TABLE, [["schema.core"]]);
      expect(core).toMatchObject({ value: "1.2.0" });
    },
  );

  it("names init for a managed Supabase project", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "supabaseDatabase", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    await project(
      marked(
        createEngineDatabase({ name: "supabaseDatabase", adapter }),
        "supabase",
      ),
      "supabase",
    );

    // What `supabase db push` of 0002 does on this database.
    await upgrade("supabase", () =>
      migrateCoreSchema(adapter, "supabaseDatabase", managedPlugins()),
    );
  });

  it("accepts the server of a release candidate's CLI at that release candidate", async () => {
    versions.cli = "1.2.0-rc.1";
    versions.server = "1.2.0-rc.1";
    deployed = "1.2.0-rc.1";
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "dynamoDB", managedPlugins());
    await project(
      marked(createEngineDatabase({ name: "dynamoDB", adapter }), "aws"),
      "aws",
    );

    await expect(run()).resolves.toMatchObject({
      success: true,
      details: {
        infrastructure: { requiredVersion: "1.2.0-rc.1", needsUpdate: false },
      },
    });
    deployed = "1.1.3";
    await expect(run()).resolves.toMatchObject({
      success: false,
      details: {
        infrastructure: {
          needsUpdate: true,
          remediation: { commands: [initReplayCommand("aws")] },
        },
      },
    });
  });

  it("names no upgrade while the database's schema is newer than this CLI's", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "dynamoDB", managedPlugins());
    await storeSetting(adapter, "schema.core", "9.0.0");
    await project(
      marked(createEngineDatabase({ name: "dynamoDB", adapter }), "aws"),
      "aws",
    );

    await expect(run()).resolves.toMatchObject({
      success: false,
      details: {
        infrastructure: {
          needsUpdate: true,
          remediation: {
            reason: expect.stringMatching(
              /^Resolve SCHEMA_NEWER_THAN_CLI first/u,
            ),
            commands: [],
          },
        },
        schema: { issues: [{ code: "SCHEMA_NEWER_THAN_CLI" }] },
      },
    });
  });

  it("names the environment as the source when init's record is not in .env.hotupdater", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "dynamoDB", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    // No .env.hotupdater: CI secrets, or a file the config loads, hold it.
    await project(
      marked(createEngineDatabase({ name: "dynamoDB", adapter }), "aws"),
      null,
    );
    vi.stubEnv("HOT_UPDATER_INIT_PROVIDER", "aws");
    vi.stubEnv("HOT_UPDATER_INIT_BUILD", "bare");
    vi.stubEnv("HOT_UPDATER_DYNAMODB_TABLE_NAME", "hot-updater");

    const command =
      "npx hot-updater init --provider aws --build bare --from-env-file <env file>";
    await expect(run()).resolves.toMatchObject({
      details: {
        infrastructure: {
          remediation: {
            reason: expect.stringContaining(
              "from the environment, not from .env.hotupdater",
            ),
            commands: [command],
          },
        },
        schema: { issues: [{ commands: [command] }] },
      },
    });
  });

  it("does not name .env.hotupdater when the environment overrides the database it saved", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "dynamoDB", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    // The file saved another table than the one the config reads now.
    const another: Record<symbol, string> = {
      [DATABASE_TARGET]: "dynamodb/rc22",
    };
    await project(
      { ...createEngineDatabase({ name: "dynamoDB", adapter }), ...another },
      "aws",
    );
    vi.stubEnv("HOT_UPDATER_DYNAMODB_TABLE_NAME", "rc22");

    await expect(run()).resolves.toMatchObject({
      details: {
        schema: {
          issues: [
            {
              commands: [
                "npx hot-updater init --provider aws --build bare --from-env-file <env file>",
              ],
            },
          ],
        },
      },
    });
  });

  it("says the server was not checked without a URL given or recorded", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "dynamoDB", managedPlugins());
    await project(
      marked(createEngineDatabase({ name: "dynamoDB", adapter }), "aws"),
      "aws",
    );

    const result = await doctor({ cwd, fetch: fetchVersion });
    expect(result).toMatchObject({
      success: true,
      details: {
        infrastructureUnchecked: {
          message:
            "The server's version was not checked: doctor was given no --server-base-url, and no agent infrastructure scaffold in hot-updater-infra/ records the server.",
          commands: ["npx hot-updater doctor --server-base-url <url>"],
        },
      },
    });
    expect(result).not.toHaveProperty("details.infrastructure");
    expect(fetchVersion).not.toHaveBeenCalled();
  });

  it("checks the server an agent scaffold records, without --server-base-url", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "d1Database", managedPlugins());
    await project(
      marked(
        createEngineDatabase({ name: "d1Database", adapter }),
        "cloudflare",
      ),
      "cloudflare",
    );
    await scaffold("cloudflare", "upgrade-bare-1.1.3", `${SERVER}/`);

    await expect(doctor({ cwd, fetch: fetchVersion })).resolves.toMatchObject({
      success: false,
      details: {
        infrastructure: {
          versionEndpoint: `${SERVER}/version`,
          recordedIn: path.join(
            "hot-updater-infra",
            "cloudflare",
            "upgrade-bare-1.1.3",
            "deployment.json",
          ),
          serverVersion: "1.1.3",
          needsUpdate: true,
        },
      },
    });
    expect(fetchVersion).toHaveBeenCalledWith(
      `${SERVER}/version`,
      expect.anything(),
    );
  });

  it("does not pick between servers several scaffolds record", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "dynamoDB", managedPlugins());
    await project(
      marked(createEngineDatabase({ name: "dynamoDB", adapter }), "aws"),
      "aws",
    );
    await scaffold("aws", "setup-bare-1.1.3", "https://one.example.com");
    await scaffold("aws", "upgrade-bare-1.2.0", "https://two.example.com");

    await expect(doctor({ cwd, fetch: fetchVersion })).resolves.toMatchObject({
      details: {
        infrastructureUnchecked: {
          message: expect.stringContaining(
            "record more than one server (https://one.example.com, https://two.example.com)",
          ),
        },
      },
    });
    expect(fetchVersion).not.toHaveBeenCalled();
  });

  it("names the scaffold upgrade instead of init for a deployment a scaffold keeps", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "d1Database", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    // Init created it; agent infra scaffolds have kept it since.
    await project(
      marked(
        createEngineDatabase({ name: "d1Database", adapter }),
        "cloudflare",
      ),
      "cloudflare",
    );
    await scaffold("cloudflare", "upgrade-bare-1.1.3", SERVER);

    const command =
      "npx hot-updater agent infra upgrade --provider cloudflare --build bare";
    const result = await doctor({ cwd, fetch: fetchVersion });
    expect(result).toMatchObject({
      success: false,
      details: {
        infrastructure: {
          needsUpdate: true,
          remediation: {
            reason: expect.stringContaining(
              "upload the new server version and preview it, then migrate the database and deploy that version back to back",
            ),
            commands: [command],
          },
        },
        schema: {
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              resolution: expect.stringContaining(
                `This deployment is kept with the agent infrastructure scaffold in ${path.join("hot-updater-infra", "cloudflare", "upgrade-bare-1.1.3")}: run \`${command}\``,
              ),
              commands: [command],
            },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("hot-updater init --provider");
  });

  it("keeps naming init beside a scaffold that was generated but never deployed", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "d1Database", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    await project(
      marked(
        createEngineDatabase({ name: "d1Database", adapter }),
        "cloudflare",
      ),
      "cloudflare",
    );
    // A fresh scaffold records no server yet.
    await scaffold("cloudflare", "setup-bare-1.2.0", null);

    await expect(run()).resolves.toMatchObject({
      details: {
        schema: { issues: [{ commands: [initReplayCommand("cloudflare")] }] },
        infrastructure: {
          remediation: { commands: [initReplayCommand("cloudflare")] },
        },
      },
    });
  });

  it("keeps naming init beside a scaffold of another database", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "d1Database", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    await project(
      marked(
        createEngineDatabase({ name: "d1Database", adapter }),
        "cloudflare",
      ),
      "cloudflare",
    );
    await scaffold("cloudflare", "upgrade-bare-1.1.3", SERVER, "bare", {
      d1DatabaseId: "another-database",
    });

    await expect(run()).resolves.toMatchObject({
      details: {
        schema: { issues: [{ commands: [initReplayCommand("cloudflare")] }] },
      },
    });
  });

  it("does not name a scaffold's upgrade while the config lists a plugin of its own", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "d1Database", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    await project(
      marked(
        createEngineDatabase({ name: "d1Database", adapter }),
        "cloudflare",
      ),
      "cloudflare",
    );
    // A server plugin of the project's own, which the scaffold's server lacks.
    const custom = definePlugin({
      id: "custom",
      schemaVersion: "1",
      schema: {},
      init: () => ({ api: {} }),
    });
    const config = await loadConfig(null);
    vi.mocked(loadConfig).mockResolvedValue({
      ...config,
      plugins: [...managedPlugins(), custom],
    } as never);
    await scaffold("cloudflare", "upgrade-bare-1.1.3", SERVER);

    const result = await run();
    expect(JSON.stringify(result)).not.toContain(
      "kept with the agent infrastructure scaffold",
    );
    expect(JSON.stringify(result)).not.toContain(
      "agent infra upgrade --provider cloudflare",
    );
    expect(result).toMatchObject({
      details: {
        infrastructure: {
          remediation: {
            reason: expect.stringContaining(
              "lists a plugin the managed server does not run (custom)",
            ),
          },
        },
      },
    });
  });

  it("names no build when the scaffolds of one deployment record different ones", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "d1Database", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    await project(
      marked(
        createEngineDatabase({ name: "d1Database", adapter }),
        "cloudflare",
      ),
      "cloudflare",
    );
    await scaffold("cloudflare", "upgrade-bare-1.2.0", SERVER, "bare");
    await scaffold("cloudflare", "upgrade-expo-1.1.3", SERVER, "expo");

    const command =
      "npx hot-updater agent infra upgrade --provider cloudflare --build <build>";
    await expect(run()).resolves.toMatchObject({
      details: {
        schema: { issues: [{ commands: [command] }] },
        infrastructure: { remediation: { commands: [command] } },
      },
    });
  });

  it("names db migrate when the config's database is another than the one init saved", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "dynamoDB", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    // The config now reaches another table than the one init replays against.
    const another: Record<symbol, string> = {
      [DATABASE_TARGET]: "dynamodb/another-table",
    };
    await project(
      { ...createEngineDatabase({ name: "dynamoDB", adapter }), ...another },
      "aws",
    );

    await expect(run()).resolves.toMatchObject({
      details: {
        infrastructure: {
          remediation: {
            commands: [
              "npx hot-updater db migrate <server file>",
              "npx hot-updater db generate <server file>",
              "npx hot-updater agent infra upgrade",
            ],
          },
        },
        schema: {
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              commands: ["npx hot-updater db migrate <server file>"],
            },
          ],
        },
      },
    });
  });

  it("names init only if the database is init's, when init saved nothing that names it", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "postgres", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    // Init saves the Vercel database URL only with consent.
    await project(
      marked(createEngineDatabase({ name: "postgres", adapter }), "vercel"),
      "vercel",
      {},
    );

    const command = initReplayCommand("vercel");
    await expect(run()).resolves.toMatchObject({
      details: {
        infrastructure: {
          remediation: {
            reason: expect.stringMatching(
              /^If hot-updater.config.ts names the database hot-updater init saved in .env.hotupdater: Run /u,
            ),
            commands: [
              command,
              "npx hot-updater db migrate <server file>",
              "npx hot-updater db generate <server file>",
              "npx hot-updater agent infra upgrade",
            ],
          },
        },
        schema: {
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              resolution: expect.stringContaining(
                "Otherwise, it is your own server's: In the server's project, run",
              ),
              commands: [command, "npx hot-updater db migrate <server file>"],
            },
          ],
        },
      },
    });
  });

  it("names db migrate for a server of the project's own, and passes once it ran and the server is deployed", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "kysely", managedPlugins());
    await storeSetting(adapter, "schema.core", "1.0.0");
    // A project whose init record names a provider whose database it left.
    const database = await project(
      createEngineDatabase({ name: "kysely", adapter }),
      "cloudflare",
    );

    await expect(run()).resolves.toMatchObject({
      success: false,
      details: {
        infrastructure: {
          needsUpdate: true,
          remediation: {
            commands: [
              "npx hot-updater db migrate <server file>",
              "npx hot-updater db generate <server file>",
              "npx hot-updater agent infra upgrade",
            ],
          },
        },
        schema: {
          issues: [
            {
              code: "SCHEMA_MIGRATION_PENDING",
              commands: ["npx hot-updater db migrate <server file>"],
            },
          ],
        },
      },
    });

    await migrate(database);
    deployed = "1.2.0";
    await expect(run()).resolves.toMatchObject({ success: true });
  });
});
