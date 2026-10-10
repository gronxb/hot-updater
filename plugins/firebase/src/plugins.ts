import { apiKeys, insights, remoteConfig } from "@hot-updater/server/plugins";

/**
 * The plugins the managed Firebase server runs: Insights, API keys on every
 * client route, and Remote Config. Its Cloud Function and init use this list,
 * which the package does not export: a config lists its plugins itself.
 */
export const plugins = [insights(), apiKeys(), remoteConfig()] as const;
