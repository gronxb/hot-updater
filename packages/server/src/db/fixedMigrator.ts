import { sql, type QueryExecutorProvider } from "kysely";

import {
  HOT_UPDATER_SCHEMA_VERSION,
  HOT_UPDATER_SETTINGS_TABLE,
} from "../schema/types";
import {
  assertSupportedMigrationMode,
  assertSupportedSchemaVersion,
  getEmptyMigrationResult,
  isCurrentSchemaVersion,
} from "./fixedMigratorShared";
import { createTableSql } from "./schema/sql";
import { createSchemaMigrationSql } from "./schema/sqlMigrations";
import {
  createSqlCreateOperations,
  getSettingsInsertSql,
} from "./schema/sqlOperations";
import { executeMigrationStatements } from "./sqlMigrationExecution";
import type {
  MigrateOptions,
  MigrationOperation,
  MigrationResult,
  Migrator,
  ORMSQLProvider,
  RelationMode,
} from "./types";

const isMissingSettingsTableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("private_hot_updater_settings") &&
    (message.includes("does not exist") ||
      message.includes("no such table") ||
      message.includes("doesn't exist") ||
      message.includes("not found"))
  );
};

const toCustomOperations = (
  statements: readonly string[],
  settingsOperation?: MigrationOperation,
): MigrationOperation[] => [
  ...statements.map(
    (statement): MigrationOperation => ({
      type: "custom",
      sql: statement,
    }),
  ),
  ...(settingsOperation ? [settingsOperation] : []),
];

export const createKyselyMigrator = ({
  db,
  provider,
  relationMode = "foreign-keys",
}: {
  db: QueryExecutorProvider;
  provider: ORMSQLProvider;
  relationMode?: RelationMode;
}): Migrator => {
  const getVersion = async (): Promise<string | undefined> => {
    try {
      const result = await sql<{ readonly value: string }>`select ${sql.ref(
        "value",
      )} from ${sql.table(HOT_UPDATER_SETTINGS_TABLE)} where ${sql.ref(
        "key",
      )} = ${"version"} limit 1`.execute(db);
      const row = result.rows[0];
      return typeof row?.value === "string" ? row.value : undefined;
    } catch (error) {
      if (!isMissingSettingsTableError(error)) throw error;
      return undefined;
    }
  };

  const makeResult = async (
    options: MigrateOptions = {},
  ): Promise<MigrationResult> => {
    assertSupportedMigrationMode(options);

    const currentVersion = await getVersion();
    if (isCurrentSchemaVersion(currentVersion)) {
      return getEmptyMigrationResult();
    }
    assertSupportedSchemaVersion(currentVersion);

    const settingsStatement = getSettingsInsertSql(provider);
    const settingsOperation =
      options.updateSettings === false
        ? undefined
        : ({
            type: "custom",
            sql: settingsStatement,
          } satisfies MigrationOperation);
    const executableSettingsStatements =
      options.updateSettings === false ? [] : [settingsStatement];
    const statements =
      currentVersion === undefined
        ? [...createTableSql(provider, relationMode), settingsStatement]
        : [
            ...createSchemaMigrationSql(
              currentVersion,
              HOT_UPDATER_SCHEMA_VERSION,
              provider,
              relationMode,
            ),
            ...executableSettingsStatements,
          ];
    const operations =
      currentVersion === undefined
        ? createSqlCreateOperations(provider, relationMode, settingsOperation)
        : toCustomOperations(
            createSchemaMigrationSql(
              currentVersion,
              HOT_UPDATER_SCHEMA_VERSION,
              provider,
              relationMode,
            ),
            settingsOperation,
          );

    return {
      operations,
      getSQL: () => statements.map((statement) => `${statement};`).join("\n\n"),
      execute: () => executeMigrationStatements({ db, provider, statements }),
    };
  };

  return {
    getVersion,
    getNameVariants: async () => undefined,
    next: async () =>
      isCurrentSchemaVersion(await getVersion())
        ? undefined
        : { version: HOT_UPDATER_SCHEMA_VERSION },
    previous: async () => undefined,
    up: makeResult,
    down: async () => {
      throw new Error("No previous schema to migrate to.");
    },
    migrateTo: async (version, options) => {
      if (version !== HOT_UPDATER_SCHEMA_VERSION) {
        throw new Error(`Invalid version ${version}`);
      }
      return makeResult(options);
    },
    migrateToLatest: makeResult,
  };
};

export { createMongoMigrator } from "./fixedMigratorMongo";
