import { type CheckForUpdateConfig, checkForUpdate } from "./checkForUpdate";
import { reload, updateBundle } from "./native";

export type RunUpdateProcessResponse =
  | {
      status: "ROLLBACK" | "UPDATE";
      shouldForceUpdate: boolean;
      id: string;
    }
  | {
      status: "UP_TO_DATE";
    };

export interface RunUpdateProcessConfig extends CheckForUpdateConfig {
  /**
   * If `true`, the app will be reloaded when the downloaded bundle is a force update.
   * If `false`, shouldForceUpdate will be returned as true but the app won't reload.
   * @default true
   */
  reloadOnForceUpdate?: boolean;
}

/**
 * Manually checks and applies updates for the application.
 *
 * @param {RunUpdateProcessConfig} config - Update process configuration
 * @param {string} config.source - Update server URL
 * @param {Record<string, string>} [config.requestHeaders] - Request headers
 * @param {boolean} [config.reloadOnForceUpdate=true] - Whether to automatically reload on force update
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
export const runUpdateProcess = async ({
  reloadOnForceUpdate = true,
  ...checkForUpdateConfig
}: RunUpdateProcessConfig): Promise<RunUpdateProcessResponse> => {
  const updateInfo = await checkForUpdate(checkForUpdateConfig);
  if (!updateInfo) {
    return {
      status: "UP_TO_DATE",
    };
  }

  const isUpdated = await updateBundle(updateInfo.id, updateInfo.fileUrl);
  if (isUpdated && updateInfo.shouldForceUpdate && reloadOnForceUpdate) {
    reload();
  }

  if (!isUpdated) {
    throw new Error("New update was found but failed to download the bundle.");
  }
  return {
    status: updateInfo.status,
    shouldForceUpdate: updateInfo.shouldForceUpdate,
    id: updateInfo.id,
  };
};
