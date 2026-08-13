import {
  bool,
  check,
  column,
  foreignKey,
  float,
  idColumn,
  index,
  integer,
  json,
  largeString,
  relation,
  schema,
  stringColumn,
  table,
  uuid,
  varchar,
} from "./dsl";
import { createSettingsTable } from "./settings";
import { HOT_UPDATER_SETTINGS_TABLE } from "./types";
import { bundlePatchesV036 } from "./v0_36_0";
import { clientAccessKeysV037 } from "./v0_37_0";
import { channelsV038 } from "./v0_38_0";

const channelIdentityCollations = {
  mysql: "utf8mb4_bin",
  mssql: "Latin1_General_100_BIN2_SC",
  sqlite: "binary",
} as const;

const catalogKeyCollations = {
  mysql: "ascii_bin",
  mssql: "Latin1_General_100_BIN2",
  sqlite: "binary",
} as const;

export const bundlesV100 = table(
  "bundles",
  {
    id: idColumn("id", "uuid"),
    platform: stringColumn("platform"),
    file_hash: stringColumn("file_hash"),
    git_commit_hash: stringColumn("git_commit_hash").nullable(),
    storage_uri: stringColumn("storage_uri"),
    metadata: json("metadata").defaultTo({}),
    manifest_storage_uri: stringColumn("manifest_storage_uri").nullable(),
    manifest_file_hash: stringColumn("manifest_file_hash").nullable(),
    asset_base_storage_uri: stringColumn("asset_base_storage_uri").nullable(),
  },
  {
    indexes: [index("bundles_platform_idx", ["platform"], ["mongodb"])],
  },
);

export const releasesV100 = table(
  "releases",
  {
    id: idColumn("id", "uuid"),
    revision: integer("revision"),
    scope_key: column("scope_key", varchar(2048)).collate(catalogKeyCollations),
    channel_id: column("channel_id", varchar(255)).collate(
      channelIdentityCollations,
    ),
    platform: stringColumn("platform"),
    kind: stringColumn("kind"),
    bundle_id: column("bundle_id", "uuid").nullable(),
    strategy: stringColumn("strategy"),
    target_app_version: stringColumn("target_app_version").nullable(),
    fingerprint_hash: stringColumn("fingerprint_hash").nullable(),
    enabled: bool("enabled"),
    should_force_update: bool("should_force_update"),
    message: stringColumn("message").nullable(),
    rollout_cohort_count: integer("rollout_cohort_count").defaultTo(1000),
    target_cohorts: json("target_cohorts").defaultTo([]),
    operation: stringColumn("operation"),
    source_release_id: column("source_release_id", "uuid").nullable(),
    created_at_ms: float("created_at_ms"),
    updated_at_ms: float("updated_at_ms"),
  },
  {
    indexes: [
      index("releases_scope_order_idx", ["scope_key", "id"]),
      index("releases_channel_platform_order_idx", [
        "channel_id",
        "platform",
        "id",
      ]),
      index("releases_bundle_id_idx", ["bundle_id"]),
      index("releases_fingerprint_hash_idx", ["fingerprint_hash"]),
      index("releases_enabled_idx", ["enabled"]),
    ],
    checks: [
      check({
        name: "releases_revision_check",
        expression: "revision >= 1",
        sqliteInline: true,
      }),
      check({
        name: "releases_kind_bundle_check",
        expression:
          "(kind = 'BUNDLE' and bundle_id is not null) or (kind = 'EMBEDDED' and bundle_id is null)",
        sqliteInline: true,
      }),
      check({
        name: "releases_strategy_target_check",
        expression:
          "(strategy = 'APP_VERSION' and target_app_version is not null and fingerprint_hash is null) or (strategy = 'FINGERPRINT' and target_app_version is null and fingerprint_hash is not null)",
        sqliteInline: true,
      }),
      check({
        name: "releases_rollout_cohort_count_check",
        expression:
          "rollout_cohort_count >= 0 and rollout_cohort_count <= 1000",
        sqliteInline: true,
      }),
      check({
        name: "releases_operation_check",
        expression: "operation in ('DEPLOY', 'PROMOTE', 'ROLLBACK')",
        sqliteInline: true,
      }),
    ],
    foreignKeys: [
      foreignKey("releases_channel_id_fk", ["channel_id"], "channels", ["id"], {
        onDelete: "restrict",
      }),
      foreignKey("releases_bundle_id_fk", ["bundle_id"], "bundles", ["id"], {
        onDelete: "restrict",
      }),
      foreignKey(
        "releases_source_release_id_fk",
        ["source_release_id"],
        "releases",
        ["id"],
        { onDelete: "set null" },
      ),
    ],
    relations: [
      relation({
        name: "channelRecord",
        fieldName: "releases",
        targetFieldName: "channelRecord",
        relationName: "releases_channels",
        columns: ["channel_id"],
        referencedTable: "channels",
        referencedColumns: ["id"],
      }),
      relation({
        name: "bundle",
        fieldName: "releases",
        targetFieldName: "bundle",
        relationName: "releases_bundles",
        columns: ["bundle_id"],
        referencedTable: "bundles",
        referencedColumns: ["id"],
      }),
      relation({
        name: "sourceRelease",
        fieldName: "derivedReleases",
        targetFieldName: "sourceRelease",
        relationName: "releases_source_release",
        columns: ["source_release_id"],
        referencedTable: "releases",
        referencedColumns: ["id"],
      }),
    ],
  },
);

export const releaseCatalogsV100 = table(
  "release_catalogs",
  {
    scope_key: idColumn("scope_key", varchar(2048)).collate(
      catalogKeyCollations,
    ),
    authority_id: column("authority_id", varchar(255)),
    strategy: stringColumn("strategy"),
    channel_id: column("channel_id", varchar(255)).collate(
      channelIdentityCollations,
    ),
    channel_key: column("channel_key", varchar(1400)).collate(
      catalogKeyCollations,
    ),
    platform: stringColumn("platform"),
    fingerprint_hash: stringColumn("fingerprint_hash").nullable(),
    generation: float("generation"),
    payload: largeString("payload"),
    catalog_hash: column("catalog_hash", varchar(71)),
    byte_size: integer("byte_size"),
    is_tombstone: bool("is_tombstone"),
    updated_at_ms: float("updated_at_ms"),
  },
  {
    indexes: [
      index("release_catalogs_channel_idx", ["channel_id"]),
      index("release_catalogs_authority_strategy_idx", [
        "authority_id",
        "strategy",
      ]),
    ],
    checks: [
      check({
        name: "release_catalogs_strategy_target_check",
        expression:
          "(strategy = 'APP_VERSION' and fingerprint_hash is null) or (strategy = 'FINGERPRINT' and fingerprint_hash is not null)",
        sqliteInline: true,
      }),
      check({
        name: "release_catalogs_generation_check",
        expression: "generation >= 1 and generation <= 9007199254740991",
        sqliteInline: true,
      }),
      check({
        name: "release_catalogs_byte_size_check",
        expression: "byte_size >= 0 and byte_size <= 262144",
        sqliteInline: true,
      }),
    ],
    foreignKeys: [
      foreignKey(
        "release_catalogs_channel_id_fk",
        ["channel_id"],
        "channels",
        ["id"],
        { onDelete: "restrict" },
      ),
    ],
    relations: [
      relation({
        name: "channelRecord",
        fieldName: "releaseCatalogs",
        targetFieldName: "channelRecord",
        relationName: "release_catalogs_channels",
        columns: ["channel_id"],
        referencedTable: "channels",
        referencedColumns: ["id"],
      }),
    ],
  },
);

export const bundleEventsV100 = table(
  "bundle_events",
  {
    id: idColumn("id", "uuid"),
    type: stringColumn("type"),
    install_id: stringColumn("install_id"),
    user_id: stringColumn("user_id").nullable(),
    username: stringColumn("username").nullable(),
    from_release_id: uuid("from_release_id").nullable(),
    from_bundle_id: uuid("from_bundle_id").nullable(),
    to_release_id: uuid("to_release_id").nullable(),
    to_bundle_id: uuid("to_bundle_id").nullable(),
    platform: stringColumn("platform"),
    app_version: stringColumn("app_version"),
    channel: stringColumn("channel"),
    cohort: stringColumn("cohort"),
    update_strategy: stringColumn("update_strategy").nullable(),
    fingerprint_hash: stringColumn("fingerprint_hash").nullable(),
    sdk_version: stringColumn("sdk_version").nullable(),
    received_at_ms: float("received_at_ms"),
  },
  {
    indexes: [
      index("bundle_events_received_at_idx", ["received_at_ms", "id"]),
      index("bundle_events_install_idx", [
        "install_id",
        "received_at_ms",
        "id",
      ]),
      index("bundle_events_user_id_idx", ["user_id", "received_at_ms", "id"]),
      index("bundle_events_username_idx", ["username", "received_at_ms", "id"]),
      index("bundle_events_to_bundle_idx", [
        "type",
        "to_bundle_id",
        "received_at_ms",
        "id",
      ]),
      index("bundle_events_from_bundle_idx", [
        "type",
        "from_bundle_id",
        "received_at_ms",
        "id",
      ]),
      index("bundle_events_to_release_idx", [
        "type",
        "to_release_id",
        "received_at_ms",
        "id",
      ]),
      index("bundle_events_from_release_idx", [
        "type",
        "from_release_id",
        "received_at_ms",
        "id",
      ]),
    ],
    checks: [
      check({
        name: "bundle_events_type_check",
        expression:
          "type in ('UPDATE_APPLIED', 'RECOVERED', 'RELEASE_ADOPTED', 'UNCHANGED')",
        sqliteInline: true,
      }),
      check({
        name: "bundle_events_platform_check",
        expression: "platform in ('ios', 'android')",
        sqliteInline: true,
      }),
      check({
        name: "bundle_events_shape_check",
        expression:
          "((type in ('UPDATE_APPLIED', 'RECOVERED', 'RELEASE_ADOPTED')) and update_strategy in ('fingerprint', 'appVersion')) or (type = 'UNCHANGED' and update_strategy is null)",
        sqliteInline: true,
      }),
      check({
        name: "bundle_events_received_at_check",
        expression: "received_at_ms >= 0",
        sqliteInline: true,
      }),
    ],
  },
);

export const v1_0_0 = schema({
  version: "1.0.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [
    channelsV038,
    bundlesV100,
    bundlePatchesV036,
    releasesV100,
    releaseCatalogsV100,
    bundleEventsV100,
    clientAccessKeysV037,
    createSettingsTable("1.0.0"),
  ],
});
