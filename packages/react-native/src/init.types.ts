import type { HotUpdaterClientPlugin } from "./clientPlugin";
import type { HotUpdaterError } from "./error";
import type { NotifyAppReadyResult } from "./native";
import type { HotUpdaterBaseURL } from "./types";

export interface HotUpdaterInitOptions<
  TPlugins extends readonly HotUpdaterClientPlugin[] =
    readonly HotUpdaterClientPlugin[],
> {
  /**
   * Client plugins, such as `insights()` and `remoteConfig()` from
   * `@hot-updater/react-native`. Each plugin's `setup` runs once for the
   * instance `init` returns; its hooks observe that instance's launch,
   * update checks, downloads, and update failures, and its API is on the
   * instance, under the plugin's id. Plugin ids must be unique.
   */
  plugins?: TPlugins;
  /** Base URL of a server exposing the Hot Updater v1 client HTTP protocol. */
  baseURL: HotUpdaterBaseURL;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
}
