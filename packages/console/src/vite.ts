import type { PluginOption } from "vite";

import { createHostedConsolePlugins } from "./vite-internal";

export interface HotUpdaterConsolePluginOptions {
  readonly auth?: string;
  readonly config?: string;
}

export const hotUpdaterConsole = (
  options: HotUpdaterConsolePluginOptions = {},
): PluginOption[] => createHostedConsolePlugins(options);
