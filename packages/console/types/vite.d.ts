import type { Plugin } from "vite";

import type { HotUpdaterConsoleConfig } from "./config";
import type { HotUpdaterConsoleServerApi } from "./hosted";

export interface HotUpdaterConsolePluginOptions {
  readonly config?: string;
}

export declare const hotUpdaterConsole: (
  options?: HotUpdaterConsolePluginOptions,
) => Plugin;

declare module "virtual:hot-updater-console/config" {
  const config: HotUpdaterConsoleConfig;
  export default config;
}

declare module "virtual:hot-updater-console/server-api" {
  export const createConsoleApi: () => Promise<HotUpdaterConsoleServerApi>;
}
