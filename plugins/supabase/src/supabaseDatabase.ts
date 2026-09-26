import type { EngineDatabase } from "@hot-updater/plugin-core";
import {
  createEngineDatabase,
  createSqlAdapter,
} from "@hot-updater/server/database";
import { createClient } from "@supabase/supabase-js";

import {
  resolveSupabaseServiceRoleKey,
  type SupabaseServiceRoleConfig,
} from "./supabaseConfig";
import { supabaseExecutor } from "./supabaseExecutor";
import { SUPABASE_TABLE_PREFIX } from "./supabaseInfrastructureNames";

export type SupabaseDatabaseConfig = SupabaseServiceRoleConfig;

/**
 * Hot Updater's database on Supabase: the storage engine through the shared
 * SQL core, fenced by the schema settings. Every read and write goes through
 * the service-role-only apply RPC, which runs no DDL, so Supabase migrations
 * create the tables.
 */
export const supabaseDatabase = (
  config: SupabaseDatabaseConfig,
): EngineDatabase => {
  const { migrations: _migrations, ...adapter } = createSqlAdapter({
    executor: supabaseExecutor(
      createClient(config.supabaseUrl, resolveSupabaseServiceRoleKey(config)),
    ),
    tablePrefix: SUPABASE_TABLE_PREFIX,
  });
  return createEngineDatabase({ name: "supabaseDatabase", adapter });
};
