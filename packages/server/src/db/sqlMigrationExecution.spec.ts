import { DatabaseSync, type SqliteValue } from "node:sqlite";

import {
  Kysely,
  MysqlDialect,
  type MysqlPool,
  type MysqlPoolConnection,
  type MysqlQueryResult,
  type MysqlStream,
  type MysqlStreamOptions,
  SqliteDialect,
} from "kysely";
import { describe, expect, it } from "vitest";

import { createV038AlterSql } from "./schema/sqlMigrations";
import { getSettingsInsertSql } from "./schema/sqlOperations";
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

type FakeMysqlState = {
  channelIdColumn?: {
    character_set_name: string | null;
    character_maximum_length: number | null;
    collation_name: string | null;
    data_type: string;
    is_nullable: "NO" | "YES";
  };
  readonly constraints: Map<
    string,
    {
      check_clause: string | null;
      constraint_type: string;
      delete_rule: string | null;
      referenced_column_name: string | null;
      referenced_table_name: string | null;
      update_rule: string | null;
    }
  >;
  readonly indexes: Map<
    string,
    {
      column_name: string;
      non_unique: number;
      seq_in_index: number;
    }[]
  >;
  schemaVersion?: string;
};

const fakeMysqlResult = (): MysqlQueryResult => ({
  affectedRows: 0,
  changedRows: 0,
  insertId: 0,
});

const executeFakeMysqlQuery = (
  state: FakeMysqlState,
  sqlText: string,
  parameters: readonly unknown[],
): MysqlQueryResult => {
  const normalized = sqlText.replace(/\s+/g, " ").trim().toLowerCase();
  const table = parameters[0];
  const name = parameters[1];

  if (normalized.includes("from information_schema.columns")) {
    return table === "bundles" && name === "channel_id" && state.channelIdColumn
      ? [state.channelIdColumn]
      : [];
  }
  if (normalized.includes("from information_schema.statistics")) {
    const metadata =
      typeof table === "string" && typeof name === "string"
        ? state.indexes.get(`${table}.${name}`)
        : undefined;
    if (!metadata) return [];
    return normalized.startsWith("select 1 as present")
      ? [{ present: 1 }]
      : metadata;
  }
  if (normalized.includes("information_schema.table_constraints")) {
    const metadata =
      typeof table === "string" && typeof name === "string"
        ? state.constraints.get(`${table}.${name}`)
        : undefined;
    if (!metadata) return [];
    return normalized.startsWith("select 1 as present")
      ? [{ present: 1 }]
      : [metadata];
  }

  if (normalized.startsWith("alter table bundles add column channel_id")) {
    if (state.channelIdColumn) throw new Error("duplicate column channel_id");
    state.channelIdColumn = {
      character_set_name: "utf8mb4",
      character_maximum_length: 255,
      collation_name: "utf8mb4_bin",
      data_type: "varchar",
      is_nullable: "YES",
    };
  } else if (
    normalized.startsWith("alter table bundles modify column channel_id")
  ) {
    if (!state.channelIdColumn) throw new Error("missing column channel_id");
    state.channelIdColumn = {
      ...state.channelIdColumn,
      is_nullable: "NO",
    };
  } else if (normalized.startsWith("create unique index channels_name_key")) {
    const key = "channels.channels_name_key";
    if (state.indexes.has(key)) throw new Error("duplicate index");
    state.indexes.set(key, [
      { column_name: "name", non_unique: 0, seq_in_index: 1 },
    ]);
  } else if (normalized.startsWith("create index bundles_channel_id_idx")) {
    const key = "bundles.bundles_channel_id_idx";
    if (state.indexes.has(key)) throw new Error("duplicate index");
    state.indexes.set(key, [
      { column_name: "channel_id", non_unique: 1, seq_in_index: 1 },
    ]);
  } else {
    const constraint =
      /^alter table (channels|bundles) add constraint (\S+)/.exec(normalized);
    const constraintTable = constraint?.[1];
    const constraintName = constraint?.[2];
    if (constraintTable && constraintName) {
      const key = `${constraintTable}.${constraintName}`;
      if (state.constraints.has(key)) throw new Error("duplicate constraint");
      state.constraints.set(
        key,
        constraintName === "bundles_channel_id_fk"
          ? {
              check_clause: null,
              constraint_type: "FOREIGN KEY",
              delete_rule: "RESTRICT",
              referenced_column_name: "id",
              referenced_table_name: "channels",
              update_rule: "RESTRICT",
            }
          : {
              check_clause: `char_length(${constraintName === "channels_id_length_check" ? "id" : "name"}) between 1 and 255`,
              constraint_type: "CHECK",
              delete_rule: null,
              referenced_column_name: null,
              referenced_table_name: null,
              update_rule: null,
            },
      );
    }
  }
  if (
    normalized.startsWith(
      "insert into private_hot_updater_settings (`key`, value)",
    )
  ) {
    state.schemaVersion = "0.38.0";
  }

  return fakeMysqlResult();
};

const createFakeMysqlKysely = (state: FakeMysqlState): Kysely<object> => {
  function query(
    sqlText: string,
    parameters: unknown[],
  ): { stream: <T>(options: MysqlStreamOptions) => MysqlStream<T> };
  function query(
    sqlText: string,
    parameters: unknown[],
    callback: (error: unknown, result: MysqlQueryResult) => void,
  ): void;
  function query(
    sqlText: string,
    parameters: unknown[],
    callback?: (error: unknown, result: MysqlQueryResult) => void,
  ): { stream: <T>(options: MysqlStreamOptions) => MysqlStream<T> } | void {
    if (callback) {
      callback(null, executeFakeMysqlQuery(state, sqlText, parameters));
      return;
    }
    throw new Error("Streaming is not supported by the fake MySQL pool.");
  }
  const connection: MysqlPoolConnection = {
    query,
    release: () => undefined,
  };
  const pool: MysqlPool = {
    end: (callback) => callback(null),
    getConnection: (callback) => callback(null, connection),
  };
  return new Kysely<object>({ dialect: new MysqlDialect({ pool }) });
};

const createFakeMysqlState = (): FakeMysqlState => ({
  constraints: new Map(),
  indexes: new Map(),
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

  it("resumes MySQL 0.38.0 after every partial-DDL boundary", async () => {
    const statements = [
      ...createV038AlterSql("mysql"),
      getSettingsInsertSql("mysql"),
    ];

    for (let boundary = 0; boundary <= statements.length; boundary += 1) {
      const state = createFakeMysqlState();
      const db = createFakeMysqlKysely(state);

      await executeMigrationStatements({
        db,
        provider: "mysql",
        statements: statements.slice(0, boundary),
      });
      await executeMigrationStatements({ db, provider: "mysql", statements });

      expect(state.channelIdColumn?.is_nullable, `boundary ${boundary}`).toBe(
        "NO",
      );
      expect(
        state.indexes.has("channels.channels_name_key"),
        `boundary ${boundary}`,
      ).toBe(true);
      expect(
        state.indexes.has("bundles.bundles_channel_id_idx"),
        `boundary ${boundary}`,
      ).toBe(true);
      expect(
        state.constraints.has("bundles.bundles_channel_id_fk"),
        `boundary ${boundary}`,
      ).toBe(true);
      expect(state.schemaVersion, `boundary ${boundary}`).toBe("0.38.0");

      await db.destroy();
    }
  });

  it("rejects a conflicting MySQL 0.38.0 object instead of silently resuming", async () => {
    const state = createFakeMysqlState();
    state.channelIdColumn = {
      character_set_name: "utf8mb4",
      character_maximum_length: 128,
      collation_name: "utf8mb4_bin",
      data_type: "varchar",
      is_nullable: "YES",
    };
    const db = createFakeMysqlKysely(state);

    await expect(
      executeMigrationStatements({
        db,
        provider: "mysql",
        statements: createV038AlterSql("mysql"),
      }),
    ).rejects.toThrow(
      "Cannot safely resume MySQL migration: column bundles.channel_id already exists.",
    );

    await db.destroy();
  });
});
