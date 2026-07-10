import { PGlite } from "@electric-sql/pglite";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type Dialect,
} from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it } from "vitest";

import { createKyselyMigrator } from "./fixedMigrator";

interface SettingsDatabase {
  readonly private_hot_updater_settings: {
    readonly key: string;
    readonly value: string;
  };
}

const mysqlDummyDialect: Dialect = {
  createAdapter: () => new MysqlAdapter(),
  createDriver: () => new DummyDriver(),
  createIntrospector: (db) => new MysqlIntrospector(db),
  createQueryCompiler: () => new MysqlQueryCompiler(),
};

describe("createKyselyMigrator", () => {
  const databases: PGlite[] = [];
  const kyselyInstances: Kysely<SettingsDatabase>[] = [];

  afterEach(async () => {
    for (const kysely of kyselyInstances.splice(0)) {
      await kysely.destroy();
    }
    for (const db of databases.splice(0)) {
      await db.close();
    }
  });

  it("includes the schema version row in fresh standalone SQL", async () => {
    const db = new PGlite();
    databases.push(db);
    const kysely = new Kysely<SettingsDatabase>({
      dialect: new PGliteDialect(db),
    });
    kyselyInstances.push(kysely);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "postgresql",
    });

    const migration = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: false,
    });

    expect(migration.getSQL?.()).toContain(
      "insert into private_hot_updater_settings (key, value) values ('version', '0.32.0')",
    );
    expect(migration.operations).not.toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining(
          "insert into private_hot_updater_settings",
        ),
      }),
    );
  });

  it("rejects unknown schema versions before writing settings", async () => {
    const db = new PGlite();
    databases.push(db);
    const kysely = new Kysely<SettingsDatabase>({
      dialect: new PGliteDialect(db),
    });
    kyselyInstances.push(kysely);
    await db.exec(`
      create table private_hot_updater_settings (
        key text primary key,
        value text not null
      );
      insert into private_hot_updater_settings (key, value)
      values ('version', '0.20.0');
    `);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "postgresql",
    });

    await expect(
      migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      }),
    ).rejects.toThrow("Unsupported Hot Updater schema version: 0.20.0");

    const version = await db.query<{ value: string }>(
      "select value from private_hot_updater_settings where key = 'version'",
    );
    expect(version.rows[0]?.value).toBe("0.20.0");
  });

  it("quotes the MySQL settings key column when reading schema version", async () => {
    const queries: string[] = [];
    const kysely = new Kysely<SettingsDatabase>({
      dialect: mysqlDummyDialect,
      log(event) {
        if (event.level === "query") queries.push(event.query.sql);
      },
    });
    kyselyInstances.push(kysely);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "mysql",
    });

    await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: false,
    });

    expect(queries[0]).toContain("where `key` = 'version'");
  });
});
