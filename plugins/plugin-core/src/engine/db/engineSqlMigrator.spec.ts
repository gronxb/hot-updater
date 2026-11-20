import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { conformanceItems } from "@hot-updater/test-utils";
import { pgliteExecutor, sqliteExecutor } from "@hot-updater/test-utils/node";
import { describe, expect, it } from "vitest";

import { SETTINGS_TABLE } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import type { SqlExecutor, SqlStatement } from "../database/sql/sqlAdapter";
import { sqlTableShapes, type SqlTableShape } from "../database/sql/sqlSchema";
import { coreSchema, coreSettings, coreTarget } from "./coreDatabase";
import { generateEngineSql } from "./engineSql";
import { createEngineSqlMigrator } from "./engineSqlMigrator";

const schema = {
  models: new Map(),
  tables: [conformanceItems],
} as unknown as ResolvedSchema;

/** Every table's declared indexes, by table name, index tables included. */
const declared = (shapes: readonly SqlTableShape[]): [string, string][] =>
  shapes.flatMap((shape) =>
    shape.indexes.flatMap((index) =>
      index.kind === "table"
        ? declared([index.table])
        : [[shape.name, index.name] as [string, string]],
    ),
  );

describe("createEngineSqlMigrator on MySQL", () => {
  it("finds a table's indexes under the lower-case names lower_case_table_names=1 reports", async () => {
    const statements: SqlStatement[] = [];
    // A server with lower_case_table_names=1: information_schema names
    // `conformance_items__byTag` in lower case, its indexes all present.
    const existing = declared(
      sqlTableShapes("mysql", [conformanceItems, SETTINGS_TABLE]),
    ).map(([t, i]) => ({ t: t.toLowerCase(), i }));
    const execute = async (statement: SqlStatement) => {
      statements.push(statement);
      if (statement.sql.includes("information_schema.statistics")) {
        return { rows: existing, changes: 0 };
      }
      return { rows: [], changes: 0 };
    };
    const executor: SqlExecutor = {
      dialect: "mysql",
      execute,
      transaction: (fn) => fn({ execute }),
    };
    const migrator = createEngineSqlMigrator({
      adapterName: "test",
      executor,
      schema,
      settings: { "schema.core": "1.2.0" },
    });
    await (await migrator.up()).execute();

    expect(
      statements.filter(({ sql }) => /^CREATE (UNIQUE )?INDEX/u.test(sql)),
    ).toEqual([]);
  });
});

/** What 1.2.0 added to 1.0's tables, removed again: the late column and its index first. */
const WITHOUT_1_2 = [
  'DROP INDEX "releases_byLabel"',
  'ALTER TABLE "releases" DROP COLUMN "label"',
  'DROP TABLE "label_sequences"',
];

/** Core's tables as a 1.2 prerelease left them: everything but `releases.label`. */
const WITHOUT_LABELS = WITHOUT_1_2;

describe("createEngineSqlMigrator over an earlier release's database", () => {
  /** Core's tables as 1.0 left them: no `native_builds`, no `releases_byScope`, no labels. */
  const earlier = () => {
    const database = new DatabaseSync(":memory:");
    database.exec(
      generateEngineSql("sqlite", coreSchema, {
        ...coreSettings,
        "schema.core": "1.0.0",
      }).join(";"),
    );
    database.exec(
      [
        ...WITHOUT_1_2,
        "DROP TABLE native_builds",
        'DROP INDEX "releases_byScope"',
      ].join(";"),
    );
    return database;
  };
  const migratorOver = (database: DatabaseSync) =>
    createEngineSqlMigrator({
      adapterName: "kysely",
      executor: sqliteExecutor(database),
      schema: coreSchema,
      settings: coreSettings,
      ordered: coreTarget.ordered,
    });

  it("lists only the tables and indexes it creates, and the settings it moves", async () => {
    const database = earlier();
    const migrator = migratorOver(database);
    const pending = await migrator.migrateToLatest();
    expect(pending.operations).toEqual([
      { type: "custom", description: "Add column: label to releases" },
      {
        type: "create-table",
        value: { ormName: "native_builds", columns: {} },
      },
      {
        type: "create-table",
        value: { ormName: "label_sequences", columns: {} },
      },
      {
        type: "custom",
        description: "Create index: releases_byScope on releases",
      },
      {
        type: "custom",
        description: "Create index: releases_byLabel on releases",
      },
      {
        type: "custom",
        description: `Record schema.core 1.0.0 → ${coreSettings["schema.core"]}`,
      },
    ]);
    await pending.execute();
    await expect(migrator.migrateToLatest()).resolves.toMatchObject({
      operations: [],
    });
  });

  it("refuses a database a newer release migrated, and writes nothing", async () => {
    const database = earlier();
    database.exec(
      "UPDATE private_hot_updater_settings SET value = '1.3.0' WHERE key = 'schema.core'",
    );
    await expect(migratorOver(database).migrateToLatest()).rejects.toThrow(
      `kysely: the database was migrated by Hot Updater 1.3.0 (schema.core "1.3.0", this CLI's "${coreSettings["schema.core"]}"). Upgrade hot-updater to 1.3.0 or later; nothing was written.`,
    );
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'native_builds'")
        .get(),
    ).toBeUndefined();
  });
});

describe("createEngineSqlMigrator adds a late column", () => {
  const RELEASE = `INSERT INTO "releases" ("id", "revision", "scope_key", "channel_id", "platform", "kind", "bundle_id", "strategy", "target_app_version", "fingerprint_hash", "enabled", "should_force_update", "message", "rollout_cohort_count", "target_cohorts", "operation", "source_release_id", "created_at_ms", "updated_at_ms", "_v") VALUES ('01900000-0000-7000-8000-000000000001', 1, 'scope', 'channel:cHJvZHVjdGlvbg', 'ios', 'BUNDLE', NULL, 'APP_VERSION', '*', NULL, true, false, NULL, 1000, '[]', 'DEPLOY', NULL, 1, 1, 0)`;

  const databases = [
    [
      "SQLite",
      async (version: string) => {
        const database = new DatabaseSync(":memory:");
        database.exec(
          generateEngineSql("sqlite", coreSchema, {
            ...coreSettings,
            "schema.core": version,
          }).join(";"),
        );
        database.exec(WITHOUT_LABELS.join(";"));
        database.exec("PRAGMA foreign_keys = OFF");
        database.exec(RELEASE);
        return sqliteExecutor(database);
      },
    ],
    [
      "PostgreSQL",
      async (version: string) => {
        const database = new PGlite();
        for (const statement of generateEngineSql("postgresql", coreSchema, {
          ...coreSettings,
          "schema.core": version,
        })) {
          await database.exec(statement);
        }
        for (const statement of WITHOUT_LABELS) await database.exec(statement);
        await database.exec("SET session_replication_role = replica");
        await database.exec(RELEASE);
        return pgliteExecutor(database);
      },
    ],
  ] as const;

  const migratorOver = (executor: SqlExecutor) =>
    createEngineSqlMigrator({
      adapterName: "kysely",
      executor,
      schema: coreSchema,
      settings: coreSettings,
      ordered: coreTarget.ordered,
    });

  const labels = async (executor: SqlExecutor) =>
    (
      await executor.execute({
        sql: 'SELECT "label" FROM "releases"',
        params: [],
      })
    ).rows.map(({ label }) => label);

  it.each(databases)(
    "adds releases.label to a 1.1 database on %s, its rows unlabeled, before its index",
    async (_dialect, open) => {
      const executor = await open("1.0.0");
      const pending = await migratorOver(executor).migrateToLatest();

      expect(pending.operations).toEqual(
        expect.arrayContaining([
          { type: "custom", description: "Add column: label to releases" },
          {
            type: "custom",
            description: "Create index: releases_byLabel on releases",
          },
        ]),
      );
      await pending.execute();

      await expect(labels(executor)).resolves.toEqual([null]);
      await expect(
        migratorOver(executor).migrateToLatest(),
      ).resolves.toMatchObject({ operations: [] });
    },
  );

  it.each(databases)(
    "adds releases.label to a database a 1.2 prerelease migrated on %s, whose settings already match",
    async (_dialect, open) => {
      const executor = await open(coreSettings["schema.core"]);
      const pending = await migratorOver(executor).migrateToLatest();

      expect(pending.operations).toEqual([
        { type: "custom", description: "Add column: label to releases" },
        {
          type: "create-table",
          value: { ormName: "label_sequences", columns: {} },
        },
        {
          type: "custom",
          description: "Create index: releases_byLabel on releases",
        },
      ]);
      await pending.execute();

      await expect(labels(executor)).resolves.toEqual([null]);
      await expect(
        migratorOver(executor).migrateToLatest(),
      ).resolves.toMatchObject({ operations: [] });
    },
  );
});
