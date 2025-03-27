import { checkForUpdate } from "./checkForUpdate";
import {
  addListener,
  getAppVersion,
  getBundleId,
  getChannel,
  getMinBundleId,
  notifyAppReady,
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
  /**
   * `HotUpdater.wrap` checks for updates at the entry point, and if there is a bundle to update, it downloads the bundle and applies the update strategy.
   *
   * @param {object} options - Configuration options
   * @param {string} options.source - Update server URL
   * @param {object} [options.requestHeaders] - Request headers
   * @param {React.ComponentType} [options.fallbackComponent] - Component to display during updates
   * @param {boolean} [options.reloadOnForceUpdate=true] - Whether to automatically reload the app on force updates
   * @param {Function} [options.onUpdateProcessCompleted] - Callback after update process completes
   * @param {Function} [options.onProgress] - Callback to track bundle download progress
   * @returns {Function} Higher-order component that wraps the app component
   *
   * @example
   * ```tsx
   * export default HotUpdater.wrap({
   *   source: "<your-update-server-url>",
   *   requestHeaders: {
   *     "Authorization": "Bearer <your-access-token>",
   *   },
   * })(App);
   * ```
   */
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
   * Fetches the current bundle ID of the app.
   */
  getBundleId,
  /**
   * Retrieves the initial bundle ID based on the build time of the native app.
   */
  getMinBundleId,
  /**
   * Fetches the current release channel of the app.
   *
   * By default, if no channel is specified, the app is assigned to the 'production' channel.
   *
   * @returns {string} The current release channel of the app
   *
   * @example
   * ```ts
   * const channel = HotUpdater.getChannel();
   * console.log(`Current channel: ${channel}`);
   * ```
   */
  getChannel,
  /**
   * Adds a listener to HotUpdater events.
   *
   * @param {keyof HotUpdaterEvent} eventName - The name of the event to listen for
   * @param {(event: HotUpdaterEvent[T]) => void} listener - The callback function to handle the event
   * @returns {() => void} A cleanup function that removes the event listener
   *
   * @example
   * ```ts
   * const unsubscribe = HotUpdater.addListener("onProgress", ({ progress }) => {
   *   console.log(`Update progress: ${progress * 100}%`);
   * });
   *
   * // Unsubscribe when no longer needed
   * unsubscribe();
   * ```
   */
  addListener,
  /**
   * Manually checks for updates.
   *
   * @param {Object} config - Update check configuration
   * @param {string} config.source - Update server URL
   * @param {Record<string, string>} [config.requestHeaders] - Request headers
   *
   * @returns {Promise<UpdateInfo | null>} Update information or null if up to date
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
   *   console.log("App is up to date");
   *   return;
   * }
   *
   * await HotUpdater.updateBundle(updateInfo.id, updateInfo.fileUrl);
   * if (updateInfo.shouldForceUpdate) {
   *   HotUpdater.reload();
   * }
   * ```
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
  /**
   * Marks the update as successful to prevent rollback.
   *
   * When you're manually handling app updates without using `HotUpdater.wrap` or `HotUpdater.runUpdateProcess`,
   * you **must** call this method after a successful update. If you skip this step,
   * Hot Updater will assume the update failed and will revert to the previous version
   * the next time the app restarts.
   *
   * @example
   * ```ts
   * await HotUpdater.notifyAppReady();
   * ```
   */
  notifyAppReady,
};
