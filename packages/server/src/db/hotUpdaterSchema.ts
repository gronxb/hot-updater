import type { ORMProvider, ORMSQLProvider, RelationMode } from "./types";

export const HOT_UPDATER_SCHEMA_VERSION = "0.31.0";
export const HOT_UPDATER_SETTINGS_TABLE = "private_hot_updater_settings";

export const hotUpdaterCreateTableOperations = [
  {
    type: "create-table",
    value: {
      ormName: "bundles",
      columns: {
        id: { ormName: "id", type: "uuid" },
        platform: { ormName: "platform", type: "string" },
        should_force_update: { ormName: "should_force_update", type: "bool" },
        enabled: { ormName: "enabled", type: "bool" },
        file_hash: { ormName: "file_hash", type: "string" },
        git_commit_hash: { ormName: "git_commit_hash", type: "string" },
        message: { ormName: "message", type: "string" },
        channel: { ormName: "channel", type: "string" },
        storage_uri: { ormName: "storage_uri", type: "string" },
        target_app_version: { ormName: "target_app_version", type: "string" },
        fingerprint_hash: { ormName: "fingerprint_hash", type: "string" },
        metadata: { ormName: "metadata", type: "json" },
        manifest_storage_uri: {
          ormName: "manifest_storage_uri",
          type: "string",
        },
        manifest_file_hash: { ormName: "manifest_file_hash", type: "string" },
        asset_base_storage_uri: {
          ormName: "asset_base_storage_uri",
          type: "string",
        },
        rollout_cohort_count: {
          ormName: "rollout_cohort_count",
          type: "integer",
        },
        target_cohorts: { ormName: "target_cohorts", type: "json" },
      },
    },
  },
  {
    type: "create-table",
    value: {
      ormName: "bundle_patches",
      columns: {
        id: { ormName: "id", type: "varchar(255)" },
        bundle_id: { ormName: "bundle_id", type: "uuid" },
        base_bundle_id: { ormName: "base_bundle_id", type: "uuid" },
        base_file_hash: { ormName: "base_file_hash", type: "string" },
        patch_file_hash: { ormName: "patch_file_hash", type: "string" },
        patch_storage_uri: { ormName: "patch_storage_uri", type: "string" },
        order_index: { ormName: "order_index", type: "integer" },
      },
    },
  },
] as const;

export const getSqlType = (type: string, provider: ORMSQLProvider): string => {
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

const sqlDefaultJson = (provider: ORMSQLProvider) =>
  provider === "postgresql" || provider === "cockroachdb"
    ? "'{}'::json"
    : "'{}'";

const sqlDefaultChannelClause = (provider: ORMSQLProvider): string =>
  provider === "mysql" ? "" : " default 'production'";

const sqlDefaultMetadataClause = (provider: ORMSQLProvider): string =>
  provider === "mysql" ? "" : ` default ${sqlDefaultJson(provider)}`;

const sqlSettingsKeyColumn = (provider: ORMSQLProvider): string =>
  provider === "mysql" ? "`key`" : "key";

const createForeignKeySql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode,
): readonly string[] => {
  if (relationMode !== "foreign-keys") return [];
  if (provider === "sqlite") return [];

  return [
    "alter table bundle_patches add constraint bundle_patches_bundle_id_fk foreign key (bundle_id) references bundles(id) on update restrict on delete cascade",
    "alter table bundle_patches add constraint bundle_patches_base_bundle_id_fk foreign key (base_bundle_id) references bundles(id) on update restrict on delete cascade",
  ];
};

const getInlineBundleConstraints = (provider: ORMSQLProvider): string =>
  provider === "sqlite"
    ? `,
constraint check_version_or_fingerprint check ((target_app_version is not null) or (fingerprint_hash is not null)),
constraint bundles_rollout_cohort_count_check check (rollout_cohort_count >= 0 and rollout_cohort_count <= 1000)`
    : "";

export const createV029AlterSql = (
  provider: ORMSQLProvider,
): readonly string[] => [
  `alter table bundles add column rollout_cohort_count ${getSqlType("integer", provider)} not null default 1000`,
  `alter table bundles add column target_cohorts ${getSqlType("json", provider)}`,
  "create index bundles_rollout_idx on bundles(rollout_cohort_count)",
  ...(provider === "sqlite"
    ? []
    : [
        "alter table bundles add constraint bundles_rollout_cohort_count_check check (rollout_cohort_count >= 0 and rollout_cohort_count <= 1000)",
      ]),
];

export const createV031AlterSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] => [
  `alter table bundles add column manifest_storage_uri ${getSqlType("string", provider)}`,
  `alter table bundles add column manifest_file_hash ${getSqlType("string", provider)}`,
  `alter table bundles add column asset_base_storage_uri ${getSqlType("string", provider)}`,
  `create table if not exists bundle_patches (
id ${getSqlType("varchar(255)", provider)} primary key,
bundle_id ${getSqlType("uuid", provider)} not null,
base_bundle_id ${getSqlType("uuid", provider)} not null,
base_file_hash ${getSqlType("string", provider)} not null,
patch_file_hash ${getSqlType("string", provider)} not null,
patch_storage_uri ${getSqlType("string", provider)} not null,
order_index ${getSqlType("integer", provider)} not null default 0
)`,
  "create index bundle_patches_bundle_id_idx on bundle_patches(bundle_id)",
  "create index bundle_patches_base_bundle_id_idx on bundle_patches(base_bundle_id)",
  ...createForeignKeySql(provider, relationMode),
];

export const createTableSql = (
  provider: ORMSQLProvider,
  relationMode: RelationMode = "foreign-keys",
): readonly string[] => [
  `create table if not exists bundles (
id ${getSqlType("uuid", provider)} primary key,
platform ${getSqlType("string", provider)} not null,
should_force_update ${getSqlType("bool", provider)} not null,
enabled ${getSqlType("bool", provider)} not null,
file_hash ${getSqlType("string", provider)} not null,
git_commit_hash ${getSqlType("string", provider)},
message ${getSqlType("string", provider)},
channel ${getSqlType("string", provider)} not null${sqlDefaultChannelClause(provider)},
storage_uri ${getSqlType("string", provider)} not null,
target_app_version ${getSqlType("string", provider)},
fingerprint_hash ${getSqlType("string", provider)},
metadata ${getSqlType("json", provider)} not null${sqlDefaultMetadataClause(provider)},
manifest_storage_uri ${getSqlType("string", provider)},
	manifest_file_hash ${getSqlType("string", provider)},
	asset_base_storage_uri ${getSqlType("string", provider)},
	rollout_cohort_count ${getSqlType("integer", provider)} not null default 1000,
	target_cohorts ${getSqlType("json", provider)}${getInlineBundleConstraints(provider)}
	)`,
  `create table if not exists bundle_patches (
id ${getSqlType("varchar(255)", provider)} primary key,
bundle_id ${getSqlType("uuid", provider)} not null,
base_bundle_id ${getSqlType("uuid", provider)} not null,
base_file_hash ${getSqlType("string", provider)} not null,
patch_file_hash ${getSqlType("string", provider)} not null,
patch_storage_uri ${getSqlType("string", provider)} not null,
order_index ${getSqlType("integer", provider)} not null default 0
)`,
  `create table if not exists ${HOT_UPDATER_SETTINGS_TABLE} (
${sqlSettingsKeyColumn(provider)} ${getSqlType("varchar(255)", provider)} primary key,
value ${getSqlType("string", provider)} not null
)`,
  provider === "mysql"
    ? "create index bundles_target_app_version_idx on bundles(target_app_version(255))"
    : "create index bundles_target_app_version_idx on bundles(target_app_version)",
  provider === "mysql"
    ? "create index bundles_fingerprint_hash_idx on bundles(fingerprint_hash(255))"
    : "create index bundles_fingerprint_hash_idx on bundles(fingerprint_hash)",
  provider === "mysql"
    ? "create index bundles_channel_idx on bundles(channel(255))"
    : "create index bundles_channel_idx on bundles(channel)",
  ...(provider === "sqlite"
    ? []
    : [
        "alter table bundles add constraint check_version_or_fingerprint check ((target_app_version is not null) or (fingerprint_hash is not null))",
      ]),
  "create index bundles_rollout_idx on bundles(rollout_cohort_count)",
  ...(provider === "sqlite"
    ? []
    : [
        "alter table bundles add constraint bundles_rollout_cohort_count_check check (rollout_cohort_count >= 0 and rollout_cohort_count <= 1000)",
      ]),
  "create index bundle_patches_bundle_id_idx on bundle_patches(bundle_id)",
  "create index bundle_patches_base_bundle_id_idx on bundle_patches(base_bundle_id)",
  ...createForeignKeySql(provider, relationMode),
];

export const getSettingsInsertSql = (provider: ORMProvider) => {
  if (provider === "mysql") {
    return `insert into ${HOT_UPDATER_SETTINGS_TABLE} (\`key\`, value) values ('version', '${HOT_UPDATER_SCHEMA_VERSION}') on duplicate key update value = '${HOT_UPDATER_SCHEMA_VERSION}'`;
  }
  return `insert into ${HOT_UPDATER_SETTINGS_TABLE} (key, value) values ('version', '${HOT_UPDATER_SCHEMA_VERSION}') on conflict (key) do update set value = '${HOT_UPDATER_SCHEMA_VERSION}'`;
};
