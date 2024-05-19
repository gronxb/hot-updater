import { getAppVersion, getBundleVersion } from "./native";
import type { UpdatePayload, UpdatePayloadArg } from "./types";
import { isNullable } from "./utils";

export type UpdateStatus = "ROLLBACK" | "UPDATE";

const findAvailablePayload = (payload: UpdatePayload[string]) => {
  return (
    payload
      ?.filter((item) => item.enabled)
      ?.sort((a, b) => b.bundleVersion - a.bundleVersion)?.[0] ?? {
      bundleVersion: 0,
      forceUpdate: false,
    }
  );
};

const checkForRollback = (
  payload: UpdatePayload[string],
  currentBundleVersion: number,
) => {
  const enabled = payload?.find(
    (item) => item.bundleVersion === currentBundleVersion,
  )?.enabled;

  if (isNullable(enabled)) {
    return false;
  }
  return !enabled;
};

export const checkForUpdate = async (updatePayload: UpdatePayloadArg) => {
  const payload =
    typeof updatePayload === "function" ? await updatePayload() : updatePayload;

  const currentAppVersion = await getAppVersion();
  const appVersionPayload = currentAppVersion
    ? payload?.[currentAppVersion]
    : [];
  const currentBundleVersion = await getBundleVersion();

  const isRollback = checkForRollback(appVersionPayload, currentBundleVersion);
  const availablePayload = await findAvailablePayload(appVersionPayload);

  if (isRollback) {
    if (availablePayload.bundleVersion === currentBundleVersion) {
      return null;
    }
    if (availablePayload.bundleVersion > currentBundleVersion) {
      return {
        bundleVersion: availablePayload.bundleVersion,
        forceUpdate: availablePayload.forceUpdate,
        status: "UPDATE" as UpdateStatus,
      };
    }
    return {
      bundleVersion: availablePayload.bundleVersion,
      forceUpdate: true,
      status: "ROLLBACK" as UpdateStatus,
    };
  }

  if (availablePayload.bundleVersion > currentBundleVersion) {
    return {
      bundleVersion: availablePayload.bundleVersion,
      forceUpdate: availablePayload.forceUpdate,
      status: "UPDATE" as UpdateStatus,
    };
  }
  return null;
};
