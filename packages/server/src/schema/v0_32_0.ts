import {
  idColumn,
  index,
  json,
  schema,
  stringColumn,
  table,
  uuid,
} from "./dsl";
import { createSettingsTable } from "./settings";
import { HOT_UPDATER_SETTINGS_TABLE } from "./types";
import { bundlePatchesV031, bundlesV031 } from "./v0_31_0";

export const bundlesV032 = bundlesV031;
export const bundlePatchesV032 = bundlePatchesV031;

export const bundleEventsV032 = table(
  "bundle_events",
  {
    id: idColumn("id", "uuid"),
    kind: stringColumn("kind"),
    install_id: stringColumn("install_id"),
    active_bundle_id: uuid("active_bundle_id"),
    previous_active_bundle_id: uuid("previous_active_bundle_id").nullable(),
    crashed_bundle_id: uuid("crashed_bundle_id").nullable(),
    platform: stringColumn("platform"),
    channel: stringColumn("channel"),
    app_version: stringColumn("app_version").nullable(),
    fingerprint_hash: stringColumn("fingerprint_hash").nullable(),
    cohort: stringColumn("cohort").nullable(),
    payload: json("payload"),
  },
  {
    indexes: [
      index("bundle_events_install_id_idx", ["install_id"]),
      index("bundle_events_active_bundle_id_idx", ["active_bundle_id"]),
      index("bundle_events_platform_channel_idx", ["platform", "channel"]),
    ],
  },
);

export const v0_32_0 = schema({
  version: "0.32.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [
    bundlesV032,
    bundlePatchesV032,
    bundleEventsV032,
    createSettingsTable("0.32.0"),
  ],
});
