export type SupabaseServiceRoleConfig =
  | {
      supabaseUrl: string;
      supabaseServiceRoleKey: string;
      supabaseAnonKey?: string;
    }
  | {
      supabaseUrl: string;
      supabaseAnonKey: string;
      supabaseServiceRoleKey?: string;
    };

export const resolveSupabaseServiceRoleKey = (
  config: SupabaseServiceRoleConfig,
): string => {
  const key = config.supabaseServiceRoleKey ?? config.supabaseAnonKey;
  if (!key) {
    throw new Error(
      "Supabase service role key is required. Set supabaseServiceRoleKey.",
    );
  }
  return key;
};
