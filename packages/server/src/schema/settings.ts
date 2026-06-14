import { idColumn, stringColumn, table, varchar } from "./dsl";
import {
  HOT_UPDATER_SETTINGS_TABLE,
  type HotUpdaterSchemaVersion,
} from "./types";

export const createSettingsTable = (
  version: HotUpdaterSchemaVersion,
) =>
  table(
    HOT_UPDATER_SETTINGS_TABLE,
    {
      key: idColumn("key", varchar(255)),
      value: stringColumn("value").defaultTo(version),
    },
    { internal: true },
  );
