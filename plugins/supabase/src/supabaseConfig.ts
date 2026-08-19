export type SupabaseServiceRoleConfig = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
};

export const resolveSupabaseServiceRoleKey = (
  config: SupabaseServiceRoleConfig,
): string => {
  if (!config.supabaseServiceRoleKey) {
    throw new Error(
      "Supabase service role key is required. Set supabaseServiceRoleKey.",
    );
  }
  return config.supabaseServiceRoleKey;
};
