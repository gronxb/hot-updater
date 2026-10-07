import type { HotUpdaterClientPlugin } from "./clientPlugin";
import type { HotUpdaterError } from "./error";
import type { HotUpdaterHttpClient } from "./httpClient";
import type { NotifyAppReadyResult } from "./native";
import type { HotUpdaterBaseURL } from "./types";

export interface HotUpdaterInitOptions {
  /**
   * Client plugins, such as `insights()` from `@hot-updater/react-native`.
   * Each plugin's `setup` runs
   * once, and its hooks observe launches, update checks, downloads, and
   * update failures. Plugin ids must be unique.
   */
  plugins?: readonly HotUpdaterClientPlugin[];
  /** Base URL of a server exposing the Hot Updater v1 client HTTP protocol. */
  baseURL: HotUpdaterBaseURL;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
}

export type InternalInitOptions = {
  client: HotUpdaterHttpClient;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
};
