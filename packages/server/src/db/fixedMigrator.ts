import { sql, type QueryExecutorProvider } from "kysely";
import type { MongoClient } from "mongodb";

import {
  HOT_UPDATER_SCHEMA_VERSION,
  HOT_UPDATER_SETTINGS_TABLE,
} from "../schema/types";
import { createMongoMigrationOperations } from "./schema/mongodb";
import {
  hotUpdaterSchema,
  schemaIndexAppliesToProvider,
} from "./schema/registry";
import { createTableSql } from "./schema/sql";
import {
  createV029AlterSql,
  createV031AlterSql,
  createV036AlterSql,
} from "./schema/sqlMigrations";
import {
  createSqlCreateOperations,
  getSettingsInsertSql,
} from "./schema/sqlOperations";
import type {
  MigrateOptions,
  MigrationOperation,
  MigrationResult,
  Migrator,
  ORMSQLProvider,
  RelationMode,
} from "./types";

const getEmptyResult = (): MigrationResult => ({
  operations: [],
  execute: async () => {},
  getSQL: () => "",
});

const assertSupportedMigrationMode = (options: MigrateOptions): void => {
  if (options.mode === "from-database") {
    throw new Error("Hot Updater migrations support only mode: 'from-schema'.");
  }
};

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

const isMongoNamespaceExistsError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const mongoError = error as { code?: unknown; codeName?: unknown };
  return mongoError.code === 48 || mongoError.codeName === "NamespaceExists";
};

const ignoreExistingCollection = (error: unknown): undefined => {
  if (isMongoNamespaceExistsError(error)) {
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

const assertSupportedSchemaVersion = (
  currentVersion: string | undefined,
): void => {
  if (
    currentVersion !== undefined &&
    currentVersion !== "0.21.0" &&
    currentVersion !== "0.29.0" &&
    currentVersion !== "0.31.0"
  ) {
    throw new Error(
      `Unsupported Hot Updater schema version: ${currentVersion}`,
    );
  }
};

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
    if (currentVersion === HOT_UPDATER_SCHEMA_VERSION) {
      return getEmptyResult();
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
            ...(currentVersion === "0.21.0"
              ? createV029AlterSql(provider)
              : []),
            ...(currentVersion === "0.21.0" || currentVersion === "0.29.0"
              ? createV031AlterSql(provider, relationMode)
              : []),
            ...(currentVersion === "0.21.0" ||
            currentVersion === "0.29.0" ||
            currentVersion === "0.31.0"
              ? createV036AlterSql(provider, relationMode)
              : []),
            ...executableSettingsStatements,
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
              ...(currentVersion === "0.21.0" ||
              currentVersion === "0.29.0" ||
              currentVersion === "0.31.0"
                ? createV036AlterSql(provider, relationMode)
                : []),
            ],
            settingsOperation,
          );

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
    assertSupportedMigrationMode(options);

    const currentVersion = await getVersion();
    if (currentVersion === HOT_UPDATER_SCHEMA_VERSION) {
      return getEmptyResult();
    }
    assertSupportedSchemaVersion(currentVersion);
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
        const channelRows = await db
          .collection<{ readonly channel: string }>("bundles")
          .aggregate<{ readonly _id: string }>([
            { $group: { _id: "$channel" } },
          ])
          .toArray();
        const channels = db.collection<{
          readonly id: string;
          readonly name: string;
        }>("channels");
        for (const row of channelRows) {
          await channels.updateOne(
            { id: row._id },
            { $setOnInsert: { id: row._id, name: row._id } },
            { upsert: true },
          );
        }
        await db
          .collection("bundles")
          .updateMany({ channel: { $exists: true } }, [
            { $set: { channel_id: "$channel" } },
            { $unset: "channel" },
          ]);
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
                {
                  name: index.name,
                  ...(index.unique ? { unique: true } : {}),
                },
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
