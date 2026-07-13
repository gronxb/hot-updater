import { supabaseDatabase } from "./supabaseDatabase";

export interface SupabaseEdgeFunctionDatabaseConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

export const supabaseEdgeFunctionDatabase = (
  config: SupabaseEdgeFunctionDatabaseConfig,
) => {
  return supabaseDatabase({
    supabaseUrl: config.supabaseUrl,
    supabaseServiceRoleKey: config.supabaseServiceRoleKey,
  });
};
