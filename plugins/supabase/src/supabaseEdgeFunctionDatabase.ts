import type { DatabasePluginHooks } from "@hot-updater/plugin-core";

import { supabaseDatabase } from "./supabaseDatabase";

export interface SupabaseEdgeFunctionDatabaseConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

export const supabaseEdgeFunctionDatabase = (
  config: SupabaseEdgeFunctionDatabaseConfig,
  hooks?: DatabasePluginHooks,
) => {
  return supabaseDatabase(
    {
      supabaseUrl: config.supabaseUrl,
      supabaseServiceRoleKey: config.supabaseServiceRoleKey,
    },
    hooks,
  );
};
