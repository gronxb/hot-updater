import type { DatabasePlugin } from "@hot-updater/plugin-core";
import {
  createLegacyDatabasePlugin,
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
 * SQL core, behind today's `DatabasePlugin` until E2, with the schema fence
 * on. Every read and write goes through the service-role-only apply RPC.
 */
export const supabaseDatabase = (
  config: SupabaseDatabaseConfig,
): DatabasePlugin =>
  createLegacyDatabasePlugin({
    name: "supabaseDatabase",
    adapter: createSqlAdapter({
      executor: supabaseExecutor(
        createClient(config.supabaseUrl, resolveSupabaseServiceRoleKey(config)),
      ),
      tablePrefix: SUPABASE_TABLE_PREFIX,
    }),
    fence: true,
  });
