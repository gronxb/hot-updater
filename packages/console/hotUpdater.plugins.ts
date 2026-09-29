import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";

// The plugins the demo console runs over hot-updater.config.ts's database.
// Local mode (`pnpm dev`, `hot-updater console`) reads them from this file,
// as `hot-updater init` writes it for a managed project; a `plugins` key in
// hot-updater.config.ts is not read.
export const plugins = [insights(), apiKeys()];
