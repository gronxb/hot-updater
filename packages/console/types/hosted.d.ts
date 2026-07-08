import type { ConfigInput } from "@hot-updater/plugin-core";

import type { ConsoleApiClient, ConsoleBundle } from "./embedded";

export type Bundle = ConsoleBundle;

export type HotUpdaterConsoleServerApi = ConsoleApiClient;
export type HotUpdaterConsoleConfig = Pick<
  ConfigInput,
  "console" | "database" | "storage"
>;

export declare function createHotUpdaterConsoleApi(
  config: HotUpdaterConsoleConfig,
): HotUpdaterConsoleServerApi;
