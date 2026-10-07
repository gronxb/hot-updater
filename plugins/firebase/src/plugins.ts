import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import { remoteConfig } from "@hot-updater/server/plugins/remote-config";

/**
 * The plugins the managed Firebase server runs: Insights, API keys on every
 * client route, and Remote Config. Its Cloud Function imports this list.
 */
export const plugins = [insights(), apiKeys(), remoteConfig()] as const;
