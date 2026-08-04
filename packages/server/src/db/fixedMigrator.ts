import { sql, type QueryExecutorProvider } from "kysely";

import {
  HOT_UPDATER_CORE_SCHEMA_KEY,
  HOT_UPDATER_SCHEMA_VERSION,
  HOT_UPDATER_SETTINGS_TABLE,
} from "../schema/types";
import {
  assertSupportedMigrationMode,
  assertSupportedSchemaVersion,
  getEmptyMigrationResult,
  inferLegacyCoreSchemaVersion,
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
  const getSetting = async (key: string): Promise<string | undefined> => {
    try {
      const result = await sql<{ readonly value: unknown }>`select ${sql.ref(
        "value",
      )} from ${sql.table(HOT_UPDATER_SETTINGS_TABLE)} where ${sql.ref(
        "key",
      )} = ${key} limit 1`.execute(db);
      const row = result.rows[0];
      if (!row) return undefined;
      if (typeof row.value !== "string") {
        throw new Error(`Invalid Hot Updater schema setting: ${key}`);
      }
      return row.value;
    } catch (error) {
      if (!isMissingSettingsTableError(error)) throw error;
      return undefined;
    }
  };

  const getCoreVersion = (): Promise<string | undefined> =>
    getSetting(HOT_UPDATER_CORE_SCHEMA_KEY);

  const getSchemaVersions = async (): Promise<{
    readonly coreVersion: string | undefined;
    readonly legacyCoreVersion: string | undefined;
  }> => {
    const coreVersion = await getCoreVersion();
    const legacyCoreVersion = inferLegacyCoreSchemaVersion(
      await getSetting("version"),
    );
    if (coreVersion !== undefined) {
      assertSupportedSchemaVersion(coreVersion);
      assertSupportedSchemaVersion(legacyCoreVersion);
    }
    return { coreVersion, legacyCoreVersion };
  };

  const getVersion = async (): Promise<string | undefined> => {
    const { coreVersion, legacyCoreVersion } = await getSchemaVersions();
    return coreVersion ?? legacyCoreVersion;
  };

  const makeResult = async (
    options: MigrateOptions = {},
  ): Promise<MigrationResult> => {
    assertSupportedMigrationMode(options);

    const { coreVersion, legacyCoreVersion } = await getSchemaVersions();
    const currentVersion = coreVersion ?? legacyCoreVersion;
    if (isCurrentSchemaVersion(coreVersion)) {
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
    const migrationStatements =
      currentVersion === undefined
        ? []
        : createSchemaMigrationSql(
            currentVersion,
            HOT_UPDATER_SCHEMA_VERSION,
            provider,
            relationMode,
          );
    const statements =
      currentVersion === undefined
        ? [...createTableSql(provider, relationMode), settingsStatement]
        : [...migrationStatements, ...executableSettingsStatements];
    const operations =
      currentVersion === undefined
        ? createSqlCreateOperations(provider, relationMode, settingsOperation)
        : toCustomOperations(migrationStatements, settingsOperation);

    return {
      operations,
      getSQL: () => statements.map((statement) => `${statement};`).join("\n\n"),
      execute: () => executeMigrationStatements({ db, provider, statements }),
    };
  };

  return {
    getVersion,
    getNameVariants: async () => undefined,
    next: async () => {
      const { coreVersion } = await getSchemaVersions();
      return isCurrentSchemaVersion(coreVersion)
        ? undefined
        : { version: HOT_UPDATER_SCHEMA_VERSION };
    },
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
