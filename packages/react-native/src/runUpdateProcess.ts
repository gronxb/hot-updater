import { type CheckForUpdateConfig, checkForUpdate } from "./checkUpdate";
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
   * @default false
   */
  reloadOnForceUpdate?: boolean;
}

export const runUpdateProcess = async ({
  reloadOnForceUpdate = false,
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
