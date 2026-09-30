import type { PluginOption } from "vite";

import { createHostedConsolePlugins } from "./vite-internal";

export interface HotUpdaterConsolePluginOptions {
  /** The console's auth module, `console.auth.ts` by default. */
  readonly auth?: string;
  /** The module whose default export is `defineConsoleConfig(...)`, `console.config.ts` by default. */
  readonly config?: string;
}

export const hotUpdaterConsole = (
  options: HotUpdaterConsolePluginOptions = {},
): PluginOption[] => createHostedConsolePlugins(options);
