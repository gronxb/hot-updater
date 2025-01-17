import { type CheckForUpdateConfig, checkForUpdate } from "./checkUpdate";
import { reload, updateBundle } from "./native";

export type RunUpdateProcessResponse =
  | {
      status: "ROLLBACK" | "UPDATE";
      isForceUpdate: boolean;
      id: string;
    }
  | {
      status: "UP_TO_DATE";
    };

export interface RunUpdateProcessConfig extends CheckForUpdateConfig {
  /**
   * If `true`, the app will be reloaded when the downloaded bundle is a force update.
   * If `false`, isForceUpdate will be returned as true but the app won't reload.
   * @default false
   */
  reloadOnForceUpdate?: boolean;
}

export const runUpdateProcess = async (
  config: RunUpdateProcessConfig,
): Promise<RunUpdateProcessResponse> => {
  const updateInfo = await checkForUpdate(config);
  if (!updateInfo) {
    return {
      status: "UP_TO_DATE",
    };
  }

  const isUpdated = await updateBundle(updateInfo.id, updateInfo.fileUrl);
  if (isUpdated && updateInfo.forceUpdate && config.reloadOnForceUpdate) {
    reload();
  }

  if (!isUpdated) {
    throw new Error("New update was found but failed to download the bundle.");
  }
  return {
    status: updateInfo.status,
    isForceUpdate: updateInfo.forceUpdate,
    id: updateInfo.id,
  };
};
