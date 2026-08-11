import {
  check,
  float,
  idColumn,
  index,
  schema,
  stringColumn,
  table,
  uniqueIndex,
  uuid,
} from "./dsl";
import { createSettingsTable } from "./settings";
import { HOT_UPDATER_SETTINGS_TABLE } from "./types";
import { bundlePatchesV036, bundlesV036 } from "./v0_36_0";

export const bundleEventsV037 = table(
  "bundle_events",
  {
    id: idColumn("id", "uuid"),
    type: stringColumn("type"),
    install_id: stringColumn("install_id"),
    user_id: stringColumn("user_id").nullable(),
    username: stringColumn("username").nullable(),
    from_bundle_id: uuid("from_bundle_id").nullable(),
    to_bundle_id: uuid("to_bundle_id"),
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
    ],
    checks: [
      check({
        name: "bundle_events_type_check",
        expression: "type in ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')",
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
          "((type in ('UPDATE_APPLIED', 'RECOVERED')) and from_bundle_id is not null and update_strategy in ('fingerprint', 'appVersion')) or (type = 'UNCHANGED' and from_bundle_id is null and update_strategy is null)",
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

export const clientAccessKeysV037 = table(
  "client_access_keys",
  {
    id: idColumn("id", "string"),
    hash: stringColumn("hash"),
    name: stringColumn("name"),
    prefix: stringColumn("prefix"),
    role: stringColumn("role"),
    created_at_ms: float("created_at_ms"),
    revoked_at_ms: float("revoked_at_ms").nullable(),
  },
  {
    indexes: [
      uniqueIndex("client_access_keys_hash_key", ["hash"]),
      index("client_access_keys_created_at_idx", ["created_at_ms", "id"]),
    ],
    checks: [
      check({
        name: "client_access_keys_role_check",
        expression: "role = 'client'",
        sqliteInline: true,
      }),
      check({
        name: "client_access_keys_created_at_check",
        expression: "created_at_ms >= 0",
        sqliteInline: true,
      }),
      check({
        name: "client_access_keys_revoked_at_check",
        expression: "revoked_at_ms is null or revoked_at_ms >= 0",
        sqliteInline: true,
      }),
    ],
  },
);

export const v0_37_0 = schema({
  version: "0.37.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [
    bundlesV036,
    bundlePatchesV036,
    bundleEventsV037,
    clientAccessKeysV037,
    createSettingsTable("0.37.0"),
  ],
});
