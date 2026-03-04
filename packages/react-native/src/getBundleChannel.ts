import {
  checkForUpdate,
  type CheckForUpdateResult,
  type InternalCheckForUpdateOptions,
} from "./checkForUpdate";
import { updateBundle } from "./native";

/**
 * Gets update information for a specific channel.
 * This is a thin wrapper around checkForUpdate with channel override.
 *
 * @param {string} channelName - The name of the channel (e.g., "production", "staging")
 *
 * @returns {Promise<CheckForUpdateResult | null>} Update information or null
 *
 * @example
 * ```ts
 * const update = await HotUpdater.getBundleChannel("staging", {
 *   updateStrategy: "appVersion",
 * });
 * ```
 */
export async function getBundleChannel(
  channelName: string,
  options: InternalCheckForUpdateOptions,
): Promise<CheckForUpdateResult | null> {
  const updateInfo = await checkForUpdate({
    ...options,
    channel: channelName,
  });

  if (!updateInfo) {
    return null;
  }

  return {
    ...updateInfo,
    updateBundle: async () => {
      return updateBundle({
        channel: channelName,
        bundleId: updateInfo.id,
        fileUrl: updateInfo.fileUrl,
        fileHash: updateInfo.fileHash,
        status: updateInfo.status,
      });
    },
  }
}
