import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";

/**
 * The plugins the managed Firebase server runs: Insights, and API keys on every
 * client route. Its Cloud Function imports this list.
 */
export const plugins = [insights(), apiKeys()] as const;
