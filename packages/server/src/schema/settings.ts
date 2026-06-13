import {
  HOT_UPDATER_SETTINGS_TABLE,
  type HotUpdaterSchemaVersion,
  type HotUpdaterTableSchema,
} from "./types";

export const createSettingsTable = (
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
