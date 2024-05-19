import { getAppVersion, getBundleVersion } from "./native";
import type { UpdatePayloadArg } from "./types";
import { isNullable } from "./utils";

export const checkForUpdate = async (updatePayload: UpdatePayloadArg) => {
  const payload =
    typeof updatePayload === "function" ? await updatePayload() : updatePayload;

  const currentAppVersion = await getAppVersion();
  const latestAppVersionPayload = currentAppVersion
    ? payload?.[currentAppVersion]
    : null;

  if (isNullable(latestAppVersionPayload)) {
    return null;
  }

  const currentBundleVersion = await getBundleVersion();
  const latestBundleVersion = latestAppVersionPayload?.bundleVersion;

  if (
    isNullable(latestBundleVersion) ||
    isNullable(currentBundleVersion) ||
    latestBundleVersion <= currentBundleVersion
  ) {
    return null;
  }

  return {
    bundleVersion: latestBundleVersion,
    forceUpdate: latestAppVersionPayload.forceUpdate,
  };
};
