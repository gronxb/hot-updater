import { sql, type Kysely } from "kysely";
import { MongoServerError, type MongoClient } from "mongodb";

import {
  createTableSql,
  createV029AlterSql,
  createV031AlterSql,
  getSettingsInsertSql,
  HOT_UPDATER_SCHEMA_VERSION,
  HOT_UPDATER_SETTINGS_TABLE,
  hotUpdaterCreateTableOperations,
} from "./hotUpdaterSchema";
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

const getSqlCreateOperations = (
  provider: ORMSQLProvider,
  relationMode: RelationMode,
  settingsOperation?: MigrationOperation,
): MigrationOperation[] => [
  ...hotUpdaterCreateTableOperations,
  {
    type: "custom",
    sql: "create index bundles_target_app_version_idx on bundles(target_app_version)",
  },
  {
    type: "custom",
    sql: "create index bundles_fingerprint_hash_idx on bundles(fingerprint_hash)",
  },
  {
    type: "custom",
    sql: "create index bundles_channel_idx on bundles(channel)",
  },
  ...(provider === "sqlite"
    ? []
    : [
        {
          type: "custom" as const,
          sql: "alter table bundles add constraint check_version_or_fingerprint check ((target_app_version is not null) or (fingerprint_hash is not null))",
        },
      ]),
  {
    type: "custom",
    sql: "create index bundles_rollout_idx on bundles(rollout_cohort_count)",
  },
  ...(provider === "sqlite"
    ? []
    : [
        {
          type: "custom" as const,
          sql: "alter table bundles add constraint bundles_rollout_cohort_count_check check (rollout_cohort_count >= 0 and rollout_cohort_count <= 1000)",
        },
      ]),
  {
    type: "custom",
    sql: "create index bundle_patches_bundle_id_idx on bundle_patches(bundle_id)",
  },
  {
    type: "custom",
    sql: "create index bundle_patches_base_bundle_id_idx on bundle_patches(base_bundle_id)",
  },
  ...(relationMode === "foreign-keys" && provider !== "sqlite"
    ? [
        {
          type: "custom" as const,
          sql: "alter table bundle_patches add constraint bundle_patches_bundle_id_fk foreign key (bundle_id) references bundles(id) on update restrict on delete cascade",
        },
        {
          type: "custom" as const,
          sql: "alter table bundle_patches add constraint bundle_patches_base_bundle_id_fk foreign key (base_bundle_id) references bundles(id) on update restrict on delete cascade",
        },
      ]
    : []),
  ...(settingsOperation ? [settingsOperation] : []),
];

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
        ? getSqlCreateOperations(provider, relationMode, settingsOperation)
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
    return {
      operations: [
        ...hotUpdaterCreateTableOperations,
        { type: "custom", sql: "create index bundles_id_idx on bundles(id)" },
        {
          type: "custom",
          sql: "create index bundles_channel_idx on bundles(channel)",
        },
        {
          type: "custom",
          sql: "create index bundles_platform_idx on bundles(platform)",
        },
        {
          type: "custom",
          sql: "create index bundles_target_app_version_idx on bundles(target_app_version)",
        },
        {
          type: "custom",
          sql: "create index bundles_fingerprint_hash_idx on bundles(fingerprint_hash)",
        },
        {
          type: "custom",
          sql: "create index bundles_rollout_idx on bundles(rollout_cohort_count)",
        },
        {
          type: "custom",
          sql: "create index bundle_patches_bundle_id_idx on bundle_patches(bundle_id)",
        },
        {
          type: "custom",
          sql: "create index bundle_patches_base_bundle_id_idx on bundle_patches(base_bundle_id)",
        },
        ...(options.updateSettings === false
          ? []
          : [
              {
                type: "custom" as const,
                key: "version",
                value: HOT_UPDATER_SCHEMA_VERSION,
              },
            ]),
      ],
      execute: async () => {
        const db = client.db();
        await db.createCollection("bundles").catch(ignoreExistingCollection);
        await db
          .createCollection("bundle_patches")
          .catch(ignoreExistingCollection);
        await db.collection("bundles").createIndex(
          { id: 1 },
          {
            name: "bundles_id_idx",
          },
        );
        await db.collection("bundles").createIndex(
          { channel: 1 },
          {
            name: "bundles_channel_idx",
          },
        );
        await db.collection("bundles").createIndex(
          { platform: 1 },
          {
            name: "bundles_platform_idx",
          },
        );
        await db.collection("bundles").createIndex(
          { target_app_version: 1 },
          {
            name: "bundles_target_app_version_idx",
          },
        );
        await db.collection("bundles").createIndex(
          { fingerprint_hash: 1 },
          {
            name: "bundles_fingerprint_hash_idx",
          },
        );
        await db.collection("bundles").createIndex(
          { rollout_cohort_count: 1 },
          {
            name: "bundles_rollout_idx",
          },
        );
        await db.collection("bundle_patches").createIndex(
          { bundle_id: 1 },
          {
            name: "bundle_patches_bundle_id_idx",
          },
        );
        await db.collection("bundle_patches").createIndex(
          { base_bundle_id: 1 },
          {
            name: "bundle_patches_base_bundle_id_idx",
          },
        );
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
