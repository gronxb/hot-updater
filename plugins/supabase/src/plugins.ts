import { apiKeys, insights, remoteConfig } from "@hot-updater/server/plugins";

/**
 * The plugins the managed Supabase server runs: Insights, API keys on every
 * client route, and Remote Config. Init migrates the database for this list,
 * which the package does not export: a config lists its plugins itself, as
 * the Edge Function does, since it imports only published entries.
 */
export const plugins = [insights(), apiKeys(), remoteConfig()] as const;
