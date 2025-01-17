import { type CheckForUpdateConfig, checkForUpdate } from "./checkUpdate";
import { updateBundle } from "./native";

export type RunUpdateProcessResponse =
  | {
      status: "ROLLBACK" | "UPDATE";
      isForceUpdate: boolean;
      id: string;
    }
  | {
      status: "UP_TO_DATE";
    };

export const runUpdateProcess = async (
  config: CheckForUpdateConfig,
): Promise<RunUpdateProcessResponse> => {
  const updateInfo = await checkForUpdate(config);
  if (!updateInfo) {
    return {
      status: "UP_TO_DATE",
    };
  }

  await updateBundle(updateInfo.id, updateInfo.fileUrl);
  return {
    status: updateInfo.status,
    isForceUpdate: updateInfo.forceUpdate,
    id: updateInfo.id,
  };
};
