import type { Bundle } from "@hot-updater/utils";
import { NIL_UUID } from "./const";
import { isNullable } from "./utils";

export const checkForRollback = (
  bundles: Bundle[],
  currentBundleId: string,
) => {
  if (currentBundleId.localeCompare(NIL_UUID) > 0) {
    return true;
  }

  const enabled = bundles?.find((item) => item.id === currentBundleId)?.enabled;
  const availableOldVersion = bundles?.find(
    (item) => item.id < currentBundleId && item.enabled,
  )?.enabled;

  if (isNullable(enabled)) {
    return Boolean(availableOldVersion);
  }
  return !enabled;
};
