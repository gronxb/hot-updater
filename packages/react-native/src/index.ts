import { type CheckForUpdateOptions, checkForUpdate } from "./checkForUpdate";
import {
  addListener,
  clearCrashHistory,
  getAppVersion,
  getBundleId,
  getChannel,
  getCrashHistory,
  getFingerprintHash,
  getMinBundleId,
  notifyAppReady as nativeNotifyAppReady,
  reload,
  type UpdateParams,
  updateBundle,
} from "./native";
import {
  type RunUpdateProcessOptions,
  runUpdateProcess,
} from "./runUpdateProcess";
import { hotUpdaterStore } from "./store";
import { wrap } from "./wrap";

export type { HotUpdaterEvent } from "./native";
export * from "./store";
export {
  extractSignatureFailure,
  isSignatureVerificationError,
  type SignatureVerificationFailure,
} from "./types";
export type { HotUpdaterOptions } from "./wrap";

addListener("onProgress", ({ progress }) => {
  hotUpdaterStore.setState({
    progress,
  });
});

/**
 * Creates a HotUpdater client instance with all update management methods.
 * This function is called once on module initialization to create a singleton instance.
 */
function createHotUpdaterClient() {
  // wrap usage tracking
  let isWrapUsed = false;

  const markWrapUsedInternal = () => {
    isWrapUsed = true;
  };

  function assertWrapUsage(methodName: string) {
    if (!isWrapUsed) {
      throw new Error(
        `[HotUpdater] ${methodName} requires HotUpdater.wrap() to be used.\n\n` +
          `To fix this issue, wrap your root component with HotUpdater.wrap():\n\n` +
          `Option 1: With automatic updates\n` +
          `  export default HotUpdater.wrap({\n` +
          `    source: getUpdateSource("<your-update-server-url>", {\n` +
          `      updateStrategy: "appVersion"\n` +
          `    })\n` +
          `  })(App);\n\n` +
          `Option 2: Manual updates only (custom flow)\n` +
          `  export default HotUpdater.wrap(App);\n\n` +
          `For more information, visit: https://hot-updater.dev/docs/react-native-api/wrap`,
      );
    }
  }

  return {
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
    wrap: (...args: Parameters<typeof wrap>) => {
      markWrapUsedInternal();
      return wrap(...args);
    },

    /**
     * Reloads the app.
     */
    reload,

    /**
     * Returns whether an update has finished downloading in this app session.
     *
     * When it returns true, calling `HotUpdater.reload()` (or restarting the app)
     * will apply the downloaded update bundle.
     *
     * - Derived from `progress` reaching 1.0
     * - Resets to false when a new download starts (progress < 1)
     *
     * @returns {boolean} True if a downloaded update is ready to apply
     * @example
     * ```ts
     * if (HotUpdater.isUpdateDownloaded()) {
     *   await HotUpdater.reload();
     * }
     * ```
     */
    isUpdateDownloaded: () => hotUpdaterStore.getSnapshot().isUpdateDownloaded,

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
     * Fetches the current channel of the app.
     *
     * If no channel is specified, the app is assigned to the 'production' channel.
     *
     * @returns {string} The current release channel of the app
     * @default "production"
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
     *   await HotUpdater.reload();
     * }
     * ```
     */
    checkForUpdate: (config: CheckForUpdateOptions) => {
      assertWrapUsage("checkForUpdate");
      return checkForUpdate(config);
    },

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
     *   await HotUpdater.reload();
     * }
     * ```
     *
     * @returns {Promise<RunUpdateProcessResponse>} The result of the update process
     */
    runUpdateProcess: (config: RunUpdateProcessOptions) => {
      assertWrapUsage("runUpdateProcess");
      return runUpdateProcess(config);
    },

    /**
     * Updates the bundle of the app.
     *
     * @param {UpdateBundleParams} params - Parameters object required for bundle update
     * @param {string} params.bundleId - The bundle ID of the app
     * @param {string|null} params.fileUrl - The URL of the zip file
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
     * await HotUpdater.updateBundle({
     *   bundleId: updateInfo.id,
     *   fileUrl: updateInfo.fileUrl
     * });
     * if (updateInfo.shouldForceUpdate) {
     *   await HotUpdater.reload();
     * }
     * ```
     */
    updateBundle: (params: UpdateParams) => {
      assertWrapUsage("updateBundle");
      return updateBundle(params);
    },

    /**
     * Fetches the fingerprint of the app.
     *
     * @returns {string} The fingerprint of the app
     *
     * @example
     * ```ts
     * const fingerprint = HotUpdater.getFingerprintHash();
     * console.log(`Fingerprint: ${fingerprint}`);
     * ```
     */
    getFingerprintHash,

    /**
     * Notifies the native side that the app has successfully started with the current bundle.
     * If the bundle matches the staging bundle, it promotes to stable.
     *
     * This function is called automatically when the client initializes. You typically don't need
     * to call this manually unless you have a custom update flow.
     *
     * @returns {boolean} true if promotion was successful or no action was needed
     *
     * @example
     * ```ts
     * // Usually not needed - called automatically on initialization
     * HotUpdater.notifyAppReady();
     * ```
     */
    notifyAppReady: nativeNotifyAppReady,

    /**
     * Gets the list of bundle IDs that have been marked as crashed.
     * These bundles will be rejected if attempted to install again.
     *
     * @returns {string[]} Array of crashed bundle IDs
     *
     * @example
     * ```ts
     * const crashedBundles = HotUpdater.getCrashHistory();
     * console.log("Crashed bundles:", crashedBundles);
     * ```
     */
    getCrashHistory,

    /**
     * Clears the crashed bundle history, allowing previously crashed bundles
     * to be installed again.
     *
     * @returns {boolean} true if clearing was successful
     *
     * @example
     * ```ts
     * // Clear crash history to allow retrying a previously failed bundle
     * HotUpdater.clearCrashHistory();
     * ```
     */
    clearCrashHistory,
  };
}

export const HotUpdater = createHotUpdaterClient();

export { getUpdateSource } from "./checkForUpdate";
