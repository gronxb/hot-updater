import { sql, type Kysely } from "kysely";
import { MongoServerError, type MongoClient } from "mongodb";

import { createMongoMigrationOperations } from "./schema/mongodb";
import {
  hotUpdaterSchema,
  schemaIndexAppliesToProvider,
} from "./schema/registry";
import { createTableSql } from "./schema/sql";
import { createV029AlterSql, createV031AlterSql } from "./schema/sqlMigrations";
import {
  createSqlCreateOperations,
  getSettingsInsertSql,
} from "./schema/sqlOperations";
import {
  HOT_UPDATER_SCHEMA_VERSION,
  HOT_UPDATER_SETTINGS_TABLE,
} from "./schema/types";
import type {
  MigrateOptions,
  MigrationOperation,
  MigrationResult,
  Migrator,
  ORMSQLProvider,
  RelationMode,
} from "./types";

interface SettingsDatabase {
  readonly private_hot_updater_settings: {
    readonly key: string;
    readonly value: string;
  };
}

const getEmptyResult = (): MigrationResult => ({
  operations: [],
  execute: async () => {},
  getSQL: () => "",
});

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

const ignoreExistingCollection = (error: unknown): undefined => {
  if (
    error instanceof MongoServerError &&
    (error.code === 48 || error.codeName === "NamespaceExists")
  ) {
    return undefined;
  }
  throw error;
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
  db: Kysely<SettingsDatabase>;
  provider: ORMSQLProvider;
  relationMode?: RelationMode;
}): Migrator => {
  const getVersion = async (): Promise<string | undefined> => {
    try {
      const row = await db
        .selectFrom(HOT_UPDATER_SETTINGS_TABLE)
        .select("value")
        .where("key", "=", "version")
        .executeTakeFirst();
      return typeof row?.value === "string" ? row.value : undefined;
    } catch (error) {
      if (!isMissingSettingsTableError(error)) throw error;
      return undefined;
    }
  };

  const makeResult = async (
    options: MigrateOptions = {},
  ): Promise<MigrationResult> => {
    const currentVersion = await getVersion();
    if (currentVersion === HOT_UPDATER_SCHEMA_VERSION) {
      return getEmptyResult();
    }

    const settingsStatement = getSettingsInsertSql(provider);
    const settingsOperation =
      options.updateSettings === false
        ? undefined
        : ({
            type: "custom",
            sql: settingsStatement,
          } satisfies MigrationOperation);
    const updateStatements =
      options.updateSettings === false ? [] : [settingsStatement];
    const statements =
      currentVersion === undefined
        ? [...createTableSql(provider, relationMode), ...updateStatements]
        : [
            ...(currentVersion === "0.21.0"
              ? createV029AlterSql(provider)
              : []),
            ...(currentVersion === "0.21.0" || currentVersion === "0.29.0"
              ? createV031AlterSql(provider, relationMode)
              : []),
            ...updateStatements,
          ];
    const operations =
      currentVersion === undefined
        ? createSqlCreateOperations(provider, relationMode, settingsOperation)
        : toCustomOperations(
            [
              ...(currentVersion === "0.21.0"
                ? createV029AlterSql(provider)
                : []),
              ...(currentVersion === "0.21.0" || currentVersion === "0.29.0"
                ? createV031AlterSql(provider, relationMode)
                : []),
            ],
            settingsOperation,
          );

    if (statements.length === 0) {
      throw new Error(
        `Unsupported Hot Updater schema version: ${currentVersion}`,
      );
    }

    return {
      operations,
      getSQL: () => statements.map((statement) => `${statement};`).join("\n\n"),
      execute: async () => {
        for (const statement of statements) {
          await sql.raw(statement).execute(db);
        }
      },
    };
  };

  return {
    getVersion,
    getNameVariants: async () => undefined,
    next: async () =>
      (await getVersion()) === HOT_UPDATER_SCHEMA_VERSION
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

export const createMongoMigrator = (client: MongoClient): Migrator => {
  const settings = client
    .db()
    .collection<{ key: string; value: unknown }>(HOT_UPDATER_SETTINGS_TABLE);
  const getVersion = async (): Promise<string | undefined> => {
    const row = await settings.findOne({ key: "version" });
    return typeof row?.value === "string" ? row.value : undefined;
  };
  const makeResult = async (
    options: MigrateOptions = {},
  ): Promise<MigrationResult> => {
    if ((await getVersion()) === HOT_UPDATER_SCHEMA_VERSION) {
      return getEmptyResult();
    }
    const settingsOperation =
      options.updateSettings === false
        ? undefined
        : ({
            type: "custom",
            key: "version",
            value: HOT_UPDATER_SCHEMA_VERSION,
          } satisfies MigrationOperation);
    return {
      operations: createMongoMigrationOperations(settingsOperation),
      execute: async () => {
        const db = client.db();
        for (const table of hotUpdaterSchema.tables) {
          if (table.internal) continue;
          await db
            .createCollection(table.ormName)
            .catch(ignoreExistingCollection);
        }
        await db.collection("bundles").createIndex(
          { id: 1 },
          {
            name: "bundles_id_idx",
          },
        );
        for (const table of hotUpdaterSchema.tables) {
          if (table.internal) continue;
          for (const index of (table.indexes ?? []).filter((item) =>
            schemaIndexAppliesToProvider(item, "mongodb"),
          )) {
            await db
              .collection(table.ormName)
              .createIndex(
                Object.fromEntries(index.columns.map((column) => [column, 1])),
                { name: index.name },
              );
          }
        }
        if (options.updateSettings !== false) {
          await settings.updateOne(
            { key: "version" },
            { $set: { value: HOT_UPDATER_SCHEMA_VERSION } },
            { upsert: true },
          );
        }
      },
    };
  };

  return {
    getVersion,
    getNameVariants: async () => undefined,
    next: async () =>
      (await getVersion()) === HOT_UPDATER_SCHEMA_VERSION
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
