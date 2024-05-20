import { getAppVersion, getBundleVersion } from "./native";
import type { UpdatePayload, UpdatePayloadArg } from "./types";
import { isNullable } from "./utils";

export type UpdateStatus = "ROLLBACK" | "UPDATE";

const findLatestPayload = (payload: UpdatePayload[string]) => {
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
  const availableOldVersion = payload?.find(
    (item) => item.bundleVersion < currentBundleVersion && item.enabled,
  )?.enabled;

  if (isNullable(enabled)) {
    return availableOldVersion;
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
  const latestPayload = await findLatestPayload(appVersionPayload);

  if (isRollback) {
    if (latestPayload.bundleVersion === currentBundleVersion) {
      return null;
    }
    if (latestPayload.bundleVersion > currentBundleVersion) {
      return {
        bundleVersion: latestPayload.bundleVersion,
        forceUpdate: latestPayload.forceUpdate,
        status: "UPDATE" as UpdateStatus,
      };
    }
    return {
      bundleVersion: latestPayload.bundleVersion,
      forceUpdate: true,
      status: "ROLLBACK" as UpdateStatus,
    };
  }

  if (latestPayload.bundleVersion > currentBundleVersion) {
    return {
      bundleVersion: latestPayload.bundleVersion,
      forceUpdate: latestPayload.forceUpdate,
      status: "UPDATE" as UpdateStatus,
    };
  }
  return null;
};
