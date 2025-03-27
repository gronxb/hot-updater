import { checkForUpdate } from "./checkForUpdate";
import {
  addListener,
  getAppVersion,
  getBundleId,
  getChannel,
  getMinBundleId,
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
  hotUpdaterStore.setState({
    progress,
  });
});

export const HotUpdater = {
  wrap,
  /**
   * Reloads the app.
   */
  reload,
  /**
   * Fetches the current app version.
   */
  getAppVersion,
  /**
   * Fetches the bundle ID of the app.
   */
  getBundleId,
  /**
   * Fetches the minimum bundle ID of the app.
   */
  getMinBundleId,
  /**
   * Fetches the channel of the app.
   */
  getChannel,
  /**
   * Adds a listener to the HotUpdater event.
   */
  addListener,
  /**
   * Manually checks for updates.
   */
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
  /**
   * Updates the bundle of the app.
   *
   * @param {string} bundleId - The bundle ID of the app
   * @param {string} zipUrl - The URL of the zip file
   *
   * @returns {Promise<boolean>} Whether the update was successful
   *
   * @example
   * ```ts
   * const updateInfo = await HotUpdater.checkForUpdate({
   *   source: "<your-update-server-url>",
   *   requestHeaders: {
   *     Authorization: "Bearer <your-access-token>",
   *   },
   * });
   *
   * if (!updateInfo) {
   *   return {
   *     status: "UP_TO_DATE",
   *   };
   * }
   *
   * await HotUpdater.updateBundle(updateInfo.id, updateInfo.fileUrl);
   * if (updateInfo.shouldForceUpdate) {
   *   HotUpdater.reload();
   * }
   * ```
   */
  updateBundle,
};
