import { type Bundle, maskUuidV7Rand, NIL_UUID } from "@hot-updater/core";
import { isNullable } from "./utils";

export const checkForRollback = (
  bundles: Bundle[],
  currentBundleId: string,
) => {
  if (currentBundleId === NIL_UUID) {
    return false;
  }

  if (bundles.length === 0) {
    return true;
  }

  const maskedCurrentId = maskUuidV7Rand(currentBundleId);
  const enabled = bundles.find(
    (item) => maskUuidV7Rand(item.id) === maskedCurrentId,
  )?.enabled;
  const availableOldVersion = bundles.find(
    (item) =>
      maskUuidV7Rand(item.id).localeCompare(maskedCurrentId) < 0 &&
      item.enabled,
  )?.enabled;

  if (isNullable(enabled)) {
    return Boolean(availableOldVersion);
  }
  return !enabled;
};
