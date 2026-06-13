import type {
  ORMProvider,
  ORMSQLProvider,
  RelationMode,
  MigrationOperation,
} from "./types";

export const HOT_UPDATER_SCHEMA_VERSION = "0.31.0";
export const HOT_UPDATER_SETTINGS_TABLE = "private_hot_updater_settings";

export type HotUpdaterColumnType =
  | "bool"
  | "integer"
  | "json"
  | "string"
  | "uuid"
  | `varchar(${number})`;

export type HotUpdaterDefault =
  | { type: "literal"; value: boolean | number | string }
  | { type: "json"; value: unknown };

export interface HotUpdaterColumnSchema {
  readonly ormName: string;
  readonly type: HotUpdaterColumnType;
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  readonly default?: HotUpdaterDefault;
}

export interface HotUpdaterIndexSchema {
  readonly name: string;
  readonly columns: readonly string[];
  readonly providers?: readonly ORMProvider[];
}

export interface HotUpdaterCheckSchema {
  readonly name: string;
  readonly expression: string;
  readonly sqliteInline?: boolean;
}

export interface HotUpdaterForeignKeySchema {
  readonly name: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly onUpdate: "restrict";
  readonly onDelete: "cascade";
}

export interface HotUpdaterRelationSchema {
  readonly name: string;
  readonly fieldName: string;
  readonly targetFieldName: string;
  readonly relationName: string;
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
}

export interface HotUpdaterTableSchema {
  readonly ormName: string;
  readonly columns: readonly HotUpdaterColumnSchema[];
  readonly indexes?: readonly HotUpdaterIndexSchema[];
  readonly checks?: readonly HotUpdaterCheckSchema[];
  readonly foreignKeys?: readonly HotUpdaterForeignKeySchema[];
  readonly relations?: readonly HotUpdaterRelationSchema[];
  readonly internal?: boolean;
}

export interface HotUpdaterVersionedSchema {
  version: string;
  settingsTable: string;
  tables: readonly HotUpdaterTableSchema[];
}

export type HotUpdaterSchemaVersion = "0.21.0" | "0.29.0" | "0.31.0";

const bundlesV021 = {
  ormName: "bundles",
  columns: [
    { ormName: "id", type: "uuid", primaryKey: true },
    { ormName: "platform", type: "string" },
    { ormName: "should_force_update", type: "bool" },
    { ormName: "enabled", type: "bool" },
    { ormName: "file_hash", type: "string" },
    { ormName: "git_commit_hash", type: "string", nullable: true },
    { ormName: "message", type: "string", nullable: true },
    {
      ormName: "channel",
      type: "string",
      default: { type: "literal", value: "production" },
    },
    { ormName: "storage_uri", type: "string" },
    { ormName: "target_app_version", type: "string", nullable: true },
    { ormName: "fingerprint_hash", type: "string", nullable: true },
    {
      ormName: "metadata",
      type: "json",
      default: { type: "json", value: {} },
    },
  ],
  indexes: [
    {
      name: "bundles_target_app_version_idx",
      columns: ["target_app_version"],
    },
    {
      name: "bundles_fingerprint_hash_idx",
      columns: ["fingerprint_hash"],
    },
    { name: "bundles_channel_idx", columns: ["channel"] },
    {
      name: "bundles_platform_idx",
      columns: ["platform"],
      providers: ["mongodb"],
    },
  ],
  checks: [
    {
      name: "check_version_or_fingerprint",
      expression:
        "(target_app_version is not null) or (fingerprint_hash is not null)",
      sqliteInline: true,
    },
  ],
} as const satisfies HotUpdaterTableSchema;

const bundlesV029 = {
  ...bundlesV021,
  columns: [
    ...bundlesV021.columns,
    {
      ormName: "rollout_cohort_count",
      type: "integer",
      default: { type: "literal", value: 1000 },
    },
    { ormName: "target_cohorts", type: "json", nullable: true },
  ],
  indexes: [
    ...bundlesV021.indexes,
    { name: "bundles_rollout_idx", columns: ["rollout_cohort_count"] },
  ],
  checks: [
    ...bundlesV021.checks,
    {
      name: "bundles_rollout_cohort_count_check",
      expression: "rollout_cohort_count >= 0 and rollout_cohort_count <= 1000",
      sqliteInline: true,
    },
  ],
} as const satisfies HotUpdaterTableSchema;

const bundlesV031 = {
  ...bundlesV029,
  columns: [
    ...bundlesV029.columns,
    { ormName: "manifest_storage_uri", type: "string", nullable: true },
    { ormName: "manifest_file_hash", type: "string", nullable: true },
    { ormName: "asset_base_storage_uri", type: "string", nullable: true },
  ],
} as const satisfies HotUpdaterTableSchema;

const bundlePatchesV031 = {
  ormName: "bundle_patches",
  columns: [
    { ormName: "id", type: "varchar(255)", primaryKey: true },
    { ormName: "bundle_id", type: "uuid" },
    { ormName: "base_bundle_id", type: "uuid" },
    { ormName: "base_file_hash", type: "string" },
    { ormName: "patch_file_hash", type: "string" },
    { ormName: "patch_storage_uri", type: "string" },
    {
      ormName: "order_index",
      type: "integer",
      default: { type: "literal", value: 0 },
    },
  ],
  indexes: [
    { name: "bundle_patches_bundle_id_idx", columns: ["bundle_id"] },
    {
      name: "bundle_patches_base_bundle_id_idx",
      columns: ["base_bundle_id"],
    },
  ],
  foreignKeys: [
    {
      name: "bundle_patches_bundle_id_fk",
      columns: ["bundle_id"],
      referencedTable: "bundles",
      referencedColumns: ["id"],
      onUpdate: "restrict",
      onDelete: "cascade",
    },
    {
      name: "bundle_patches_base_bundle_id_fk",
      columns: ["base_bundle_id"],
      referencedTable: "bundles",
      referencedColumns: ["id"],
      onUpdate: "restrict",
      onDelete: "cascade",
    },
  ],
  relations: [
    {
      name: "bundle",
      fieldName: "patches",
      targetFieldName: "bundle",
      relationName: "bundle_patches_bundles_patches",
      columns: ["bundle_id"],
      referencedTable: "bundles",
      referencedColumns: ["id"],
    },
    {
      name: "baseBundle",
      fieldName: "baseForPatches",
      targetFieldName: "baseBundle",
      relationName: "bundle_patches_bundles_baseForPatches",
      columns: ["base_bundle_id"],
      referencedTable: "bundles",
      referencedColumns: ["id"],
    },
  ],
} as const satisfies HotUpdaterTableSchema;

const createSettingsTable = (
  version: HotUpdaterSchemaVersion,
): HotUpdaterTableSchema => ({
  ormName: HOT_UPDATER_SETTINGS_TABLE,
  internal: true,
  columns: [
    { ormName: "key", type: "varchar(255)", primaryKey: true },
    {
      ormName: "value",
      type: "string",
      default: { type: "literal", value: version },
    },
  ],
});

export const hotUpdaterSchemaVersions: readonly HotUpdaterVersionedSchema[] = [
  {
    version: "0.21.0",
    settingsTable: HOT_UPDATER_SETTINGS_TABLE,
    tables: [bundlesV021, createSettingsTable("0.21.0")],
  },
  {
    version: "0.29.0",
    settingsTable: HOT_UPDATER_SETTINGS_TABLE,
    tables: [bundlesV029, createSettingsTable("0.29.0")],
  },
  {
    version: "0.31.0",
    settingsTable: HOT_UPDATER_SETTINGS_TABLE,
    tables: [bundlesV031, bundlePatchesV031, createSettingsTable("0.31.0")],
  },
];

export const hotUpdaterSchema =
  hotUpdaterSchemaVersions[hotUpdaterSchemaVersions.length - 1]!;

const getSchemaVersionIndex = (version: string): number =>
  hotUpdaterSchemaVersions.findIndex((schema) => schema.version === version);

export const getHotUpdaterSchemaVersion = (
  version: string,
): HotUpdaterVersionedSchema => {
  const schema = hotUpdaterSchemaVersions.find(
    (item) => item.version === version,
  );
  if (!schema)
    throw new Error(`Unsupported Hot Updater schema version: ${version}`);
  return schema;
};

export const getSchemaTable = (name: string): HotUpdaterTableSchema => {
  const table = hotUpdaterSchema.tables.find((item) => item.ormName === name);
  if (!table) throw new Error(`Unknown Hot Updater schema table: ${name}`);
  return table;
};

export const getSchemaColumn = (
  table: HotUpdaterTableSchema,
  name: string,
): HotUpdaterColumnSchema => {
  const column = table.columns.find((item) => item.ormName === name);
  if (!column) {
    throw new Error(
      `Unknown Hot Updater schema column: ${table.ormName}.${name}`,
    );
  }
  return column;
};

export const hotUpdaterDataTables = hotUpdaterSchema.tables.filter(
  (table) => !table.internal,
);

export const schemaIndexAppliesToProvider = (
  index: HotUpdaterIndexSchema,
  provider: ORMProvider,
): boolean => !index.providers || index.providers.includes(provider);

export const hotUpdaterCreateTableOperations: MigrationOperation[] =
  hotUpdaterDataTables.map((table) => ({
    type: "create-table",
    value: {
      ormName: table.ormName,
      columns: Object.fromEntries(
        table.columns.map((column) => [
          column.ormName,
          { ormName: column.ormName, type: column.type },
        ]),
      ),
    },
  }));

export const getSqlType = (
  type: HotUpdaterColumnType,
  provider: ORMSQLProvider,
): string => {
  if (provider === "sqlite") {
    if (type === "bool" || type === "integer") return "integer";
    return "text";
  }
  if (provider === "mysql") {
    if (type === "uuid") return "char(36)";
    if (type === "bool") return "boolean";
    if (type === "integer") return "integer";
    if (type === "json") return "json";
    if (type.startsWith("varchar")) return type;
    return "text";
  }
  if (type === "uuid") return "uuid";
  if (type === "bool") return "boolean";
  if (type === "integer") return "integer";
  if (type === "json") return "json";
  if (type.startsWith("varchar")) return type;
  return "text";
};

const sqlStringLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const sqlDefaultClause = (
  column: HotUpdaterColumnSchema,
  provider: ORMSQLProvider,
): string => {
  const value = column.default;
  if (!value) return "";
  if (
    provider === "mysql" &&
    (column.type === "json" || column.type === "string")
  ) {
    return "";
  }
  if (value.type === "json") {
    const json = sqlStringLiteral(JSON.stringify(value.value));
    return provider === "postgresql" || provider === "cockroachdb"
      ? ` default ${json}::json`
      : ` default ${json}`;
  }
  if (typeof value.value === "string") {
    return ` default ${sqlStringLiteral(value.value)}`;
  }
  return ` default ${String(value.value)}`;
};

const sqlColumnName = (
  table: HotUpdaterTableSchema,
  column: HotUpdaterColumnSchema,
  provider: ORMSQLProvider,
): string =>
  table.ormName === HOT_UPDATER_SETTINGS_TABLE &&
  column.ormName === "key" &&
  provider === "mysql"
    ? "`key`"
    : column.ormName;

const sqlColumnDefinition = (
  table: HotUpdaterTableSchema,
  column: HotUpdaterColumnSchema,
  provider: ORMSQLProvider,
): string => {
  const constraints = [
    column.primaryKey ? "primary key" : undefined,
    column.nullable ? undefined : "not null",
  ].filter(Boolean);
  return (
    [
      sqlColumnName(table, column, provider),
      getSqlType(column.type, provider),
      ...constraints,
    ].join(" ") + sqlDefaultClause(column, provider)
  );
};

const sqlIndexColumn = (
  table: HotUpdaterTableSchema,
  columnName: string,
  provider: ORMSQLProvider,
): string => {
  const column = getSchemaColumn(table, columnName);
  return provider === "mysql" && column.type === "string"
    ? `${columnName}(255)`
    : columnName;
};

export const createIndexSql = (
  table: HotUpdaterTableSchema,
  index: HotUpdaterIndexSchema,
  provider: ORMSQLProvider,
): string =>
  `create index ${index.name} on ${table.ormName}(${index.columns
    .map((column) => sqlIndexColumn(table, column, provider))
    .join(", ")})`;

const createForeignKeySql = (
  table: HotUpdaterTableSchema,
  foreignKey: HotUpdaterForeignKeySchema,
): string =>
  `alter table ${table.ormName} add constraint ${foreignKey.name} foreign key (${foreignKey.columns.join(", ")}) references ${foreignKey.referencedTable}(${foreignKey.referencedColumns.join(", ")}) on update ${foreignKey.onUpdate} on delete ${foreignKey.onDelete}`;

const createCheckSql = (
  table: HotUpdaterTableSchema,
  check: HotUpdaterCheckSchema,
): string =>
  `alter table ${table.ormName} add constraint ${check.name} check (${check.expression})`;

const inlineSqlChecks = (
  table: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
): string[] =>
  provider === "sqlite"
    ? (table.checks ?? [])
        .filter((check) => check.sqliteInline)
        .map((check) => `constraint ${check.name} check (${check.expression})`)
    : [];

const createTableStatement = (
  table: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
): string => {
  const lines = [
    ...table.columns.map((column) =>
      sqlColumnDefinition(table, column, provider),
    ),
    ...inlineSqlChecks(table, provider),
  ];
  return `create table if not exists ${table.ormName} (\n${lines.join(",\n")}\n)`;
};

export const createForeignKeySqlStatements = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] => {
  if (relationMode !== "foreign-keys" || provider === "sqlite") return [];
  return hotUpdaterSchema.tables.flatMap((table) =>
    (table.foreignKeys ?? []).map((foreignKey) =>
      createForeignKeySql(table, foreignKey),
    ),
  );
};

export const createTableSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] => [
  ...hotUpdaterSchema.tables.map((table) =>
    createTableStatement(table, provider),
  ),
  ...hotUpdaterSchema.tables.flatMap((table) =>
    (table.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, provider))
      .map((index) => createIndexSql(table, index, provider)),
  ),
  ...(provider === "sqlite"
    ? []
    : hotUpdaterSchema.tables.flatMap((table) =>
        (table.checks ?? []).map((check) => createCheckSql(table, check)),
      )),
  ...createForeignKeySqlStatements(provider, relationMode),
];

const tableMap = (
  schema: HotUpdaterVersionedSchema,
): Map<string, HotUpdaterTableSchema> =>
  new Map(schema.tables.map((table) => [table.ormName, table]));

const nameMap = <T extends { readonly name: string }>(
  items: readonly T[] | undefined,
): Map<string, T> => new Map((items ?? []).map((item) => [item.name, item]));

const columnMap = (
  table: HotUpdaterTableSchema,
): Map<string, HotUpdaterColumnSchema> =>
  new Map(table.columns.map((column) => [column.ormName, column]));

const stableStringify = (value: unknown): string => JSON.stringify(value);

const assertSameSchemaValue = (
  location: string,
  left: unknown,
  right: unknown,
) => {
  if (stableStringify(left) !== stableStringify(right)) {
    throw new Error(
      `Unsupported Hot Updater schema change at ${location}. Add an explicit migration step before changing existing schema metadata.`,
    );
  }
};

const assertNoUnsupportedTableChanges = (
  previous: HotUpdaterTableSchema,
  next: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
) => {
  const nextColumns = columnMap(next);
  for (const previousColumn of previous.columns) {
    const nextColumn = nextColumns.get(previousColumn.ormName);
    if (!nextColumn) {
      throw new Error(
        `Unsupported Hot Updater schema change at ${previous.ormName}.${previousColumn.ormName}. Dropping columns requires an explicit migration step.`,
      );
    }
    assertSameSchemaValue(
      `${previous.ormName}.${previousColumn.ormName}`,
      previousColumn,
      nextColumn,
    );
  }

  const compareNamedItems = <T extends { readonly name: string }>(
    location: string,
    previousItems: readonly T[] | undefined,
    nextItems: readonly T[] | undefined,
  ) => {
    const nextItemsByName = nameMap(nextItems);
    for (const previousItem of previousItems ?? []) {
      const nextItem = nextItemsByName.get(previousItem.name);
      if (!nextItem) {
        throw new Error(
          `Unsupported Hot Updater schema change at ${location}.${previousItem.name}. Removing schema metadata requires an explicit migration step.`,
        );
      }
      assertSameSchemaValue(
        `${location}.${previousItem.name}`,
        previousItem,
        nextItem,
      );
    }
  };

  compareNamedItems(
    `${previous.ormName}.indexes`,
    previous.indexes?.filter((index) =>
      schemaIndexAppliesToProvider(index, provider),
    ),
    next.indexes?.filter((index) =>
      schemaIndexAppliesToProvider(index, provider),
    ),
  );
  compareNamedItems(`${previous.ormName}.checks`, previous.checks, next.checks);
  compareNamedItems(
    `${previous.ormName}.foreignKeys`,
    previous.foreignKeys,
    next.foreignKeys,
  );
};

const createAddedTableSql = (
  table: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
  relationMode: RelationMode,
): readonly string[] => [
  createTableStatement(table, provider),
  ...(table.indexes ?? [])
    .filter((index) => schemaIndexAppliesToProvider(index, provider))
    .map((index) => createIndexSql(table, index, provider)),
  ...(provider === "sqlite"
    ? []
    : (table.checks ?? []).map((check) => createCheckSql(table, check))),
  ...(relationMode === "foreign-keys" && provider !== "sqlite"
    ? (table.foreignKeys ?? []).map((foreignKey) =>
        createForeignKeySql(table, foreignKey),
      )
    : []),
];

const createChangedTableSql = (
  previous: HotUpdaterTableSchema,
  next: HotUpdaterTableSchema,
  provider: ORMSQLProvider,
  relationMode: RelationMode,
): readonly string[] => {
  assertNoUnsupportedTableChanges(previous, next, provider);

  const previousColumns = columnMap(previous);
  const previousIndexes = nameMap(
    previous.indexes?.filter((index) =>
      schemaIndexAppliesToProvider(index, provider),
    ),
  );
  const previousChecks = nameMap(previous.checks);
  const previousForeignKeys = nameMap(previous.foreignKeys);

  return [
    ...next.columns
      .filter((column) => !previousColumns.has(column.ormName))
      .map(
        (column) =>
          `alter table ${next.ormName} add column ${sqlColumnDefinition(
            next,
            column,
            provider,
          )}`,
      ),
    ...(next.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, provider))
      .filter((index) => !previousIndexes.has(index.name))
      .map((index) => createIndexSql(next, index, provider)),
    ...(provider === "sqlite"
      ? []
      : (next.checks ?? [])
          .filter((check) => !previousChecks.has(check.name))
          .map((check) => createCheckSql(next, check))),
    ...(relationMode === "foreign-keys" && provider !== "sqlite"
      ? (next.foreignKeys ?? [])
          .filter((foreignKey) => !previousForeignKeys.has(foreignKey.name))
          .map((foreignKey) => createForeignKeySql(next, foreignKey))
      : []),
  ];
};

export const createSchemaMigrationSql = (
  fromVersion: string,
  toVersion: string,
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] => {
  const fromIndex = getSchemaVersionIndex(fromVersion);
  const toIndex = getSchemaVersionIndex(toVersion);
  if (fromIndex === -1) {
    throw new Error(`Unsupported Hot Updater schema version: ${fromVersion}`);
  }
  if (toIndex === -1) {
    throw new Error(`Unsupported Hot Updater schema version: ${toVersion}`);
  }
  if (fromIndex > toIndex) {
    throw new Error(`Cannot migrate Hot Updater schema down to ${toVersion}.`);
  }

  const statements: string[] = [];
  for (let index = fromIndex + 1; index <= toIndex; index += 1) {
    const previous = hotUpdaterSchemaVersions[index - 1]!;
    const next = hotUpdaterSchemaVersions[index]!;
    const previousTables = tableMap(previous);

    for (const table of next.tables) {
      if (table.internal) continue;
      const previousTable = previousTables.get(table.ormName);
      statements.push(
        ...(previousTable
          ? createChangedTableSql(previousTable, table, provider, relationMode)
          : createAddedTableSql(table, provider, relationMode)),
      );
    }
  }

  return statements;
};

export const createV029AlterSql = (
  provider: ORMSQLProvider,
): readonly string[] => createSchemaMigrationSql("0.21.0", "0.29.0", provider);

export const createV031AlterSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] =>
  createSchemaMigrationSql("0.29.0", "0.31.0", provider, relationMode);

export const getSettingsInsertSql = (provider: ORMProvider) => {
  if (provider === "mysql") {
    return `insert into ${HOT_UPDATER_SETTINGS_TABLE} (\`key\`, value) values ('version', '${HOT_UPDATER_SCHEMA_VERSION}') on duplicate key update value = '${HOT_UPDATER_SCHEMA_VERSION}'`;
  }
  return `insert into ${HOT_UPDATER_SETTINGS_TABLE} (key, value) values ('version', '${HOT_UPDATER_SCHEMA_VERSION}') on conflict (key) do update set value = '${HOT_UPDATER_SCHEMA_VERSION}'`;
};

export const createSqlCreateOperations = (
  provider: ORMSQLProvider,
  relationMode: RelationMode,
  settingsOperation?: MigrationOperation,
): MigrationOperation[] => [
  ...hotUpdaterCreateTableOperations,
  ...hotUpdaterSchema.tables.flatMap((table) =>
    (table.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, provider))
      .map(
        (index): MigrationOperation => ({
          type: "custom",
          sql: createIndexSql(table, index, provider),
        }),
      ),
  ),
  ...(provider === "sqlite"
    ? []
    : hotUpdaterSchema.tables.flatMap((table) =>
        (table.checks ?? []).map(
          (check): MigrationOperation => ({
            type: "custom",
            sql: createCheckSql(table, check),
          }),
        ),
      )),
  ...(relationMode === "foreign-keys" && provider !== "sqlite"
    ? hotUpdaterSchema.tables.flatMap((table) =>
        (table.foreignKeys ?? []).map(
          (foreignKey): MigrationOperation => ({
            type: "custom",
            sql: createForeignKeySql(table, foreignKey),
          }),
        ),
      )
    : []),
  ...(settingsOperation ? [settingsOperation] : []),
];

export const createMongoMigrationOperations = (
  settingsOperation?: MigrationOperation,
): MigrationOperation[] => [
  ...hotUpdaterCreateTableOperations,
  {
    type: "custom",
    sql: "create index bundles_id_idx on bundles(id)",
  },
  ...hotUpdaterSchema.tables.flatMap((table) =>
    (table.indexes ?? [])
      .filter((index) => schemaIndexAppliesToProvider(index, "mongodb"))
      .map(
        (index): MigrationOperation => ({
          type: "custom",
          sql: `create index ${index.name} on ${table.ormName}(${index.columns.join(
            ", ",
          )})`,
        }),
      ),
  ),
  ...(settingsOperation ? [settingsOperation] : []),
];
