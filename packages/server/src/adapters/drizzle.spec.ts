import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SqliteValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import {
  setupDatabasePluginTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { createClient } from "@libsql/client";
import type { SQL } from "drizzle-orm";
import { drizzle as libsql } from "drizzle-orm/libsql";
import { drizzle as pglite } from "drizzle-orm/pglite";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { afterAll, describe, expect, it } from "vitest";

import {
  createBundleRowFixture,
  createChannelRowFixture,
  createReleaseRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import {
  legacyFacadeSchema,
  legacyFacadeSettings,
} from "../database/legacyFacade";
import { isMultiIndex, quoteSql } from "../database/sql/sqlSchema";
import { generateEngineSql } from "../db/engineSql";
import { HotUpdaterSchemaMigrationRequiredError } from "../db/schemaReadiness";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import { createHotUpdater } from "../index";
import {
  drizzleAdapter,
  DrizzleTransactionUnsupportedError,
  type DrizzleProvider,
} from "./drizzle";

/** Every data table; the settings rows stay across tests. */
const dataTables = legacyFacadeSchema.tables.flatMap((table) => [
  table.name,
  ...table.indexes
    .filter((index) => isMultiIndex(table, index))
    .map((index) => `${table.name}__${index.name}`),
]);

const temporaryDirectory = mkdtemp(
  path.join(os.tmpdir(), "hot-updater-drizzle-"),
);
afterAll(async () =>
  rm(await temporaryDirectory, { recursive: true, force: true }),
);
let files = 0;
const temporaryFile = async () =>
  `file:${path.join(await temporaryDirectory, `${(files += 1)}.db`)}`;
/** A libSQL file in WAL mode, so reads never wait on a committing writer. */
const libsqlFile = async () => {
  const client = createClient({ url: await temporaryFile() });
  await client.execute("PRAGMA journal_mode = WAL");
  return client;
};

const engineSql = (dialect: "postgresql" | "sqlite") =>
  generateEngineSql(dialect, legacyFacadeSchema, legacyFacadeSettings);

const backends = {
  postgresql: async () => {
    const client = new PGlite();
    await client.exec(engineSql("postgresql").join(";\n"));
    return {
      db: pglite(client),
      exec: (sql: string) => client.exec(sql).then(() => undefined),
      close: () => client.close(),
    };
  },
  sqlite: async () => {
    // A file: each libSQL transaction opens a connection, and `:memory:` would be a new database.
    const client = await libsqlFile();
    await client.executeMultiple(engineSql("sqlite").join(";\n"));
    return {
      db: libsql(client),
      exec: (sql: string) => client.executeMultiple(sql),
      close: async () => client.close(),
    };
  },
} as const;

for (const provider of ["postgresql", "sqlite"] as const) {
  let backend: Awaited<ReturnType<(typeof backends)[typeof provider]>>;
  setupDatabasePluginTestSuite({
    createHttpClient: (options) =>
      startHttpTestServer(
        createHotUpdater({ ...options, clientAccess: { type: "public" } })
          .handlers,
      ),
    name: `drizzleAdapter (${provider})`,
    migrate: async () => {
      backend = await backends[provider]();
    },
    createPlugin: () => drizzleAdapter({ db: backend.db, provider }),
    reset: async () => {
      const quote = (name: string) => quoteSql(provider, name);
      await backend.exec(
        provider === "postgresql"
          ? `TRUNCATE ${dataTables.map(quote).join(", ")} CASCADE`
          : dataTables.map((name) => `DELETE FROM ${quote(name)};`).join(""),
      );
    },
    dispose: () => backend.close(),
  });
}

/** A sync Drizzle SQLite database as better-sqlite3's driver answers: over `node:sqlite`. */
const syncSqlite = (database: DatabaseSync) => {
  const dialect = new SQLiteSyncDialect();
  const prepare = (query: SQL) => {
    const { sql, params } = dialect.sqlToQuery(query);
    return {
      statement: database.prepare(sql),
      params: params as SqliteValue[],
    };
  };
  return {
    resultKind: "sync" as const,
    all: (query: SQL) => {
      const { statement, params } = prepare(query);
      return statement.all(...params);
    },
    run: (query: SQL) => {
      const { statement, params } = prepare(query);
      return statement.run(...params);
    },
  };
};

const seed = async (plugin: DatabaseAdapterWithCapabilities) => {
  const channel = createChannelRowFixture("production");
  const bundle = createBundleRowFixture("1");
  const release = createReleaseRowFixture("1", bundle, channel);
  await plugin.models.channels.insert({
    row: channel,
    onConflict: "returnExisting",
  });
  await expect(
    plugin.commit({
      changes: [
        { model: "bundles", operation: "insert", row: bundle },
        { model: "releases", operation: "insert", row: release },
      ],
    }),
  ).resolves.toEqual({ committed: true });
  return { bundle, release };
};

describe("drizzleAdapter drivers", () => {
  it("runs a sync SQLite driver one statement at a time, with BEGIN IMMEDIATE transactions", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(engineSql("sqlite").join(";\n"));
    const plugin = drizzleAdapter({
      db: syncSqlite(database),
      provider: "sqlite",
    });
    const { bundle } = await seed(plugin);
    const inserts = Array.from({ length: 8 }, (_, n) =>
      plugin.commit({
        changes: [
          {
            model: "bundles",
            operation: "insert",
            row: createBundleRowFixture(String(100 + n)),
          },
        ],
      }),
    );
    await expect(Promise.all(inserts)).resolves.toHaveLength(8);
    await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
      bundle,
    );
    await expect(plugin.models.bundles.count()).resolves.toBe(9);
    database.close();
  });

  it("refuses a driver without interactive transactions on first use, naming the supported ones", async () => {
    const client = new PGlite();
    await client.exec(engineSql("postgresql").join(";\n"));
    const db = pglite(client);
    const withoutTransactions = {
      execute: db.execute.bind(db),
      transaction: () => {
        throw new Error("No transactions support in neon-http driver");
      },
    };
    const plugin = drizzleAdapter({
      db: withoutTransactions,
      provider: "postgresql",
    });
    const read = await plugin.models.channels
      .list({})
      .catch((caught: unknown) => caught);
    expect(read).toBeInstanceOf(DrizzleTransactionUnsupportedError);
    expect(String(read)).toContain("better-sqlite3");
    // A write first cannot know whether anything was sent, but names the cause.
    const write = await plugin
      .commit({
        changes: [
          {
            model: "bundles",
            operation: "insert",
            row: createBundleRowFixture("2"),
          },
        ],
      })
      .catch((caught: unknown) => caught);
    expect((write as Error).cause).toBeInstanceOf(
      DrizzleTransactionUnsupportedError,
    );
    await client.close();
  });

  it("resolves a lazy database on first use", async () => {
    let resolved = 0;
    const plugin = drizzleAdapter({
      db: async () => {
        resolved += 1;
        return (await backends.sqlite()).db;
      },
      provider: "sqlite",
    });
    expect(resolved).toBe(0);
    await seed(plugin);
    await plugin.models.channels.list({});
    expect(resolved).toBe(1);
  });
});

describe("drizzleAdapter schema and migrations", () => {
  const directory = mkdtemp(path.join(import.meta.dirname, ".drizzle-"));
  afterAll(async () => rm(await directory, { recursive: true, force: true }));

  /** The generated schema file, loaded as drizzle-kit loads it. */
  const load = async (provider: DrizzleProvider) => {
    const schema = drizzleAdapter({
      db: {},
      provider,
    }).generateSchema!("latest");
    const file = path.join(await directory, `${provider}.ts`);
    await writeFile(file, schema.code);
    expect(schema.path).toBe("hot-updater-schema.ts");
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  };

  it.each(["postgresql", "sqlite"] as const)(
    "applies the generated %s schema with drizzle-kit, writes the settings with db migrate, and serves behind the fence",
    async (provider) => {
      const kit = await import("drizzle-kit/api");
      const imports = await load(provider);
      const statements =
        provider === "postgresql"
          ? await kit.generateMigration(
              kit.generateDrizzleJson({}),
              kit.generateDrizzleJson(imports),
            )
          : await kit.generateSQLiteMigration(
              await kit.generateSQLiteDrizzleJson({}),
              await kit.generateSQLiteDrizzleJson(imports),
            );
      const client =
        provider === "postgresql" ? new PGlite() : await libsqlFile();
      const run = async (sql: string) =>
        client instanceof PGlite
          ? client.exec(sql).then(() => undefined)
          : client.executeMultiple(sql);
      for (const statement of statements) await run(statement);
      const db = client instanceof PGlite ? pglite(client) : libsql(client);
      const plugin = drizzleAdapter({ db, provider });

      await expect(plugin.models.channels.list({})).rejects.toBeInstanceOf(
        HotUpdaterSchemaMigrationRequiredError,
      );
      const migrator = plugin.createMigrator!();
      const pending = await migrator.migrateToLatest();
      expect(pending.operations).toEqual([
        expect.objectContaining({ type: "custom" }),
      ]);
      await pending.execute();
      await expect(migrator.migrateToLatest()).resolves.toMatchObject({
        operations: [],
      });
      await expect(migrator.getVersion()).resolves.toBe("1.0.0");
      const { release } = await seed(plugin);
      await expect(
        plugin.models.releases.findById(release.id),
      ).resolves.toEqual(release);
      await (client instanceof PGlite ? client.close() : client.close());
    },
  );

  it("asks for the ORM's tables first, and refuses a database from before the engine", async () => {
    const empty = await libsqlFile();
    await expect(
      drizzleAdapter({ db: libsql(empty), provider: "sqlite" })
        .createMigrator!().migrateToLatest(),
    ).rejects.toThrow("drizzle-kit push");

    const legacy = await libsqlFile();
    await legacy.executeMultiple(
      "CREATE TABLE private_hot_updater_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO private_hot_updater_settings VALUES ('schema.core', '1.0.0');",
    );
    await expect(
      drizzleAdapter({ db: libsql(legacy), provider: "sqlite" })
        .createMigrator!().migrateToLatest(),
    ).rejects.toMatchObject({
      setting: { key: "schema.engine", expected: "1", found: null },
    });
    empty.close();
    legacy.close();
  });
});
