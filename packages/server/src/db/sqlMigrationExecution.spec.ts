import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { Kysely, SqliteDialect } from "kysely";
import { describe, expect, it } from "vitest";

import { executeMigrationStatements } from "./sqlMigrationExecution";

const createSqliteKysely = (database: DatabaseSync): Kysely<object> =>
  new Kysely<object>({
    dialect: new SqliteDialect({
      database: {
        close: () => database.close(),
        prepare: (sqlText) => {
          const statement = database.prepare(sqlText);
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

describe("executeMigrationStatements", () => {
  it("rolls back SQLite statements and restores foreign keys when a statement fails", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec("pragma foreign_keys = on");
    const db = createSqliteKysely(database);

    await expect(
      executeMigrationStatements({
        db,
        provider: "sqlite",
        statements: [
          "create table migration_rows (id integer primary key)",
          "insert into migration_rows (id) values (1)",
          "insert into missing_rows (id) values (1)",
        ],
      }),
    ).rejects.toThrow("no such table: missing_rows");

    expect(
      database
        .prepare(
          "select name from sqlite_master where type = 'table' and name = 'migration_rows'",
        )
        .all(),
    ).toEqual([]);
    expect(database.prepare("pragma foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });

    await db.destroy();
  });
});
