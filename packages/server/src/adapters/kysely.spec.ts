import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import {
  setupDatabaseTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { Kysely, SqliteDialect } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it } from "vitest";

import {
  createBundleEventRowFixture,
  createBundleFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { createDatabasePluginApis } from "../assembly/databasePlugins";
import { createInProcessCoreApi } from "../core/api";
import { builtInSchema } from "../database/builtInDatabase";
import { DatabaseConstraintError } from "../database/errors";
import { isMultiIndex, quoteSql } from "../database/sql/sqlSchema";
import { HotUpdaterSchemaMigrationRequiredError } from "../db/schemaReadiness";
import type { ToolingDatabase } from "../db/types";
import { createHotUpdater } from "../index";
import { createInsightsModel, insights } from "../plugins/insights";
import { kyselyAdapter, type SQLProvider } from "./kysely";

/** Every data table the migration creates; the settings rows stay. */
const dataTables = builtInSchema.tables.flatMap((table) => [
  table.name,
  ...table.indexes
    .filter((index) => isMultiIndex(table, index))
    .map((index) => `${table.name}__${index.name}`),
]);

/** Kysely over `node:sqlite`, as Kysely's SQLite dialect expects. */
const sqliteKysely = (database: DatabaseSync) =>
  new Kysely<object>({
    dialect: new SqliteDialect({
      database: {
        close: () => database.close(),
        prepare: (query) => {
          const statement = database.prepare(query);
          return {
            reader: statement.columns().length > 0,
            all: (parameters) =>
              statement.all(...(parameters as SqliteValue[])),
            run: (parameters) => {
              const result = statement.run(...(parameters as SqliteValue[]));
              return {
                changes: result.changes,
                lastInsertRowid: result.lastInsertRowid,
              };
            },
            iterate: (parameters) =>
              statement.iterate(...(parameters as SqliteValue[])),
          };
        },
      },
    }),
  });

const migrate = async (database: ToolingDatabase) =>
  (await database.createMigrator!().migrateToLatest()).execute();

/** The Insights plugin's model over a database, on the server's tables. */
const insightsOf = (database: ToolingDatabase) =>
  createInsightsModel(
    createDatabasePluginApis(database, [insights()]).insights,
  );

const backends = {
  postgresql: () => {
    const client = new PGlite();
    return {
      db: new Kysely<object>({ dialect: new PGliteDialect(client) }),
      exec: (sql: string) => client.exec(sql).then(() => undefined),
      close: () => client.close(),
    };
  },
  sqlite: () => {
    const database = new DatabaseSync(":memory:");
    return {
      db: sqliteKysely(database),
      exec: async (sql: string) => database.exec(sql),
      close: async () => undefined,
    };
  },
} satisfies Record<Exclude<SQLProvider, "mysql">, () => unknown>;

for (const provider of ["postgresql", "sqlite"] as const) {
  let backend: ReturnType<(typeof backends)[typeof provider]> | undefined;
  setupDatabaseTestSuite({
    createHttpClient: (options) =>
      startHttpTestServer(
        createHotUpdater({
          ...options,
          plugins: [insights()],
          clientAccess: "public",
        }).handlers,
      ),
    createInsightsModel: insightsOf,
    name: `kyselyAdapter (${provider})`,
    migrate: async () => {
      backend = backends[provider]();
      await migrate(kyselyAdapter({ db: backend.db, provider }));
    },
    createDatabase: () => kyselyAdapter({ db: backend!.db, provider }),
    reset: async () => {
      const quote = (name: string) => quoteSql(provider, name);
      await backend!.exec(
        provider === "postgresql"
          ? `TRUNCATE ${dataTables.map(quote).join(", ")} CASCADE`
          : dataTables.map((name) => `DELETE FROM ${quote(name)};`).join(""),
      );
    },
    dispose: async () => {
      await backend!.db.destroy();
      await backend!.close();
      backend = undefined;
    },
  });
}

describe("kyselyAdapter migrations and fence", () => {
  it("migrates once, answers nothing to migrate afterwards, and serves behind the fence", async () => {
    const { db, close } = backends.postgresql();
    const database = kyselyAdapter({ db, provider: "postgresql" });
    const core = createInProcessCoreApi(database.adapter);
    const migrator = database.createMigrator!();
    try {
      await expect(core.listChannels()).rejects.toBeInstanceOf(
        HotUpdaterSchemaMigrationRequiredError,
      );
      await expect(migrator.getVersion()).resolves.toBeUndefined();
      const pending = await migrator.migrateToLatest();
      expect(pending.getSQL?.()).toContain(
        'CREATE TABLE IF NOT EXISTS "bundles"',
      );
      expect(
        pending.operations.filter(({ type }) => type === "create-table"),
      ).toHaveLength(builtInSchema.tables.length);
      await pending.execute();
      await expect(migrator.getVersion()).resolves.toBe("1.0.0");
      await expect(migrator.migrateToLatest()).resolves.toMatchObject({
        operations: [],
      });
      await expect(core.listChannels()).resolves.toEqual([]);
    } finally {
      await db.destroy();
      await close();
    }
  });

  it("refuses to migrate a database from before the storage engine", async () => {
    const { db, exec, close } = backends.postgresql();
    try {
      await exec(
        `CREATE TABLE private_hot_updater_settings (key varchar(255) PRIMARY KEY, value varchar(255) NOT NULL, _v bigint NOT NULL DEFAULT 0);
         INSERT INTO private_hot_updater_settings (key, value) VALUES ('schema.core', '1.0.0');`,
      );
      const migrator = kyselyAdapter({
        db,
        provider: "postgresql",
      }).createMigrator!();
      await expect(migrator.migrateToLatest()).rejects.toMatchObject({
        setting: { key: "schema.engine", expected: "1", found: null },
      });
    } finally {
      await db.destroy();
      await close();
    }
  });

  it("rolls back a failed event write whole and accepts the retry", async () => {
    const { db, exec, close } = backends.postgresql();
    const database = kyselyAdapter({ db, provider: "postgresql" });
    const model = insightsOf(database);
    try {
      await migrate(database);
      await exec(
        "ALTER TABLE bundle_events ADD CONSTRAINT reject_event CHECK (install_id <> 'install-703')",
      );
      const event = createBundleEventRowFixture("703", 100);
      await expect(model.recordEvent({ event })).rejects.toThrow();
      await expect(
        model.findLatestEvents({ installId: event.install_id }),
      ).resolves.toEqual([]);
      await exec("ALTER TABLE bundle_events DROP CONSTRAINT reject_event");
      await model.recordEvent({ event });
      await expect(
        model.findLatestEvents({ installId: event.install_id }),
      ).resolves.toEqual([event]);
    } finally {
      await db.destroy();
      await close();
    }
  });

  it("keeps references without database foreign keys", async () => {
    const { db, close } = backends.postgresql();
    const database = kyselyAdapter({ db, provider: "postgresql" });
    const core = createInProcessCoreApi(database.adapter);
    try {
      const pending = await database.createMigrator!().migrateToLatest();
      expect(pending.getSQL?.()).not.toContain("FOREIGN KEY");
      await pending.execute();
      const owner = createBundleFixture("952");
      await expect(
        core.deploy([
          {
            bundle: {
              ...owner,
              patches: [
                {
                  baseBundleId: "missing-base",
                  baseFileHash: "base-hash",
                  byteSize: 1,
                  patchFileHash: "patch-hash",
                  patchStorageUri: "storage://patches/952.patch",
                },
              ],
            },
            release: {
              channel: "production",
              enabled: false,
              fingerprintHash: null,
              message: null,
              shouldForceUpdate: false,
              targetAppVersion: "*",
            },
          },
        ]),
      ).rejects.toBeInstanceOf(DatabaseConstraintError);
      await expect(core.getBundle(owner.id)).resolves.toBeNull();
    } finally {
      await db.destroy();
      await close();
    }
  });
});
