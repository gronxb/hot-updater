import type { Lazy } from "@hot-updater/plugin-core";

export type SupabaseServiceRoleConfig = {
  supabaseUrl: string;
  /**
   * The project's service role key, or a function that returns it, such as
   * `secret("<name>")` in `hot-updater.config.ts`: called on the first
   * request, so a config loads without the key.
   */
  supabaseServiceRoleKey: Lazy<string>;
};

export const resolveSupabaseServiceRoleKey = async (
  config: SupabaseServiceRoleConfig,
): Promise<string> => {
  const { supabaseServiceRoleKey } = config;
  const key =
    typeof supabaseServiceRoleKey === "function"
      ? await supabaseServiceRoleKey()
      : supabaseServiceRoleKey;
  if (!key) {
    throw new Error(
      "Supabase service role key is required. Set supabaseServiceRoleKey.",
    );
  }
  return key;
};
