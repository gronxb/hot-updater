import {
  supabaseDatabase,
  type SupabaseDatabaseConfig,
} from "./supabaseDatabase";

export type SupabaseEdgeFunctionDatabaseConfig = SupabaseDatabaseConfig;

export const supabaseEdgeFunctionDatabase = supabaseDatabase;
