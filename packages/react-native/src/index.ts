import { checkForUpdate } from "./checkForUpdate";
import {
  addListener,
  getAppVersion,
  getBundleId,
  reload,
  updateBundle,
} from "./native";
import { runUpdateProcess } from "./runUpdateProcess";
import { hotUpdaterStore } from "./store";
import { wrap } from "./wrap";

export type { HotUpdaterConfig } from "./wrap";
export type { HotUpdaterEvent } from "./native";

export * from "./store";

addListener("onProgress", ({ progress }) => {
  hotUpdaterStore.setProgress(progress);
});

export const HotUpdater = {
  wrap,

  reload,
  getAppVersion,
  getBundleId,
  addListener,

  checkForUpdate,
  /**
   * Manually checks and applies updates for the application.
   *
   * @param {RunUpdateProcessConfig} config - Update process configuration
   * @param {string} config.source - Update server URL
   * @param {Record<string, string>} [config.requestHeaders] - Request headers
   * @param {boolean} [config.reloadOnForceUpdate=false] - Whether to automatically reload on force update
   *
   * @example
   * ```ts
   * // Auto reload on force update
   * const result = await HotUpdater.runUpdateProcess({
   *   source: "<your-update-server-url>",
   *   requestHeaders: {
   *     // Add necessary headers
   *   },
   *   reloadOnForceUpdate: true
   * });
   *
   * // Manually handle reload on force update
   * const result = await HotUpdater.runUpdateProcess({
   *   source: "<your-update-server-url>",
   *   reloadOnForceUpdate: false
   * });
   *
   * if(result.status !== "UP_TO_DATE" && result.shouldForceUpdate) {
   *   HotUpdater.reload();
   * }
   * ```
   *
   * @returns {Promise<RunUpdateProcessResponse>} The result of the update process
   */
  runUpdateProcess,
  updateBundle,
};
