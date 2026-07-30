import type { ConfigResponse } from "@hot-updater/cli-tools";
import type {
  ConsoleApiClient,
  ConsoleBundle,
} from "./embedded";

export type Bundle = ConsoleBundle;

export type HotUpdaterConsoleServerApi = ConsoleApiClient;

export declare function createHotUpdaterConsoleApi(
  config: ConfigResponse,
): HotUpdaterConsoleServerApi;

export type { ConfigResponse };
