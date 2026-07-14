import {
  check,
  idColumn,
  index,
  integer,
  schema,
  stringColumn,
  table,
  uuid,
} from "./dsl";
import { createSettingsTable } from "./settings";
import { HOT_UPDATER_SETTINGS_TABLE } from "./types";
import { bundlePatchesV036, bundlesV036, channelsV036 } from "./v0_36_0";

export const bundleEventsV037 = table(
  "bundle_events",
  {
    id: idColumn("id", "uuid"),
    type: stringColumn("type"),
    install_id: stringColumn("install_id"),
    user_id: stringColumn("user_id").nullable(),
    username: stringColumn("username").nullable(),
    from_bundle_id: uuid("from_bundle_id"),
    to_bundle_id: uuid("to_bundle_id"),
    platform: stringColumn("platform"),
    app_version: stringColumn("app_version"),
    channel: stringColumn("channel"),
    cohort: stringColumn("cohort"),
    update_strategy: stringColumn("update_strategy"),
    fingerprint_hash: stringColumn("fingerprint_hash").nullable(),
    sdk_version: stringColumn("sdk_version").nullable(),
    received_at_ms: integer("received_at_ms"),
  },
  {
    indexes: [
      index("bundle_events_installed_bundle_idx", [
        "type",
        "to_bundle_id",
        "received_at_ms",
        "id",
      ]),
      index("bundle_events_recovered_bundle_idx", [
        "type",
        "from_bundle_id",
        "received_at_ms",
        "id",
      ]),
      index("bundle_events_install_idx", [
        "install_id",
        "received_at_ms",
        "id",
      ]),
      index("bundle_events_user_id_idx", ["user_id", "received_at_ms", "id"]),
      index("bundle_events_username_idx", ["username", "received_at_ms", "id"]),
      index("bundle_events_cohort_idx", [
        "cohort",
        "type",
        "received_at_ms",
        "id",
      ]),
      index("bundle_events_received_at_idx", ["received_at_ms", "id"]),
    ],
    checks: [
      check({
        name: "bundle_events_type_check",
        expression: "type in ('UPDATE_APPLIED', 'RECOVERED')",
        sqliteInline: true,
      }),
      check({
        name: "bundle_events_update_strategy_check",
        expression: "update_strategy in ('fingerprint', 'appVersion')",
        sqliteInline: true,
      }),
    ],
  },
);

export const v0_37_0 = schema({
  version: "0.37.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [
    channelsV036,
    bundlesV036,
    bundlePatchesV036,
    bundleEventsV037,
    createSettingsTable("0.37.0"),
  ],
});
