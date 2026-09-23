import { SETTINGS_TABLE } from "@hot-updater/server/database";

export const SUPABASE_V1_FUNCTION_NAME = "hot-updater-v1";

/** Namespaces Hot Updater's tables beside a project's own, and beside v0's. */
export const SUPABASE_TABLE_PREFIX = "hot_updater_v1_";
export const SUPABASE_APPLY_FUNCTION = "hot_updater_v1_apply";
export const SUPABASE_SETTINGS_TABLE =
  SUPABASE_TABLE_PREFIX + SETTINGS_TABLE.name;
