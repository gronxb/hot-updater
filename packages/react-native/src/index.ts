import { checkForUpdate } from "./checkForUpdate";
import { NIL_UUID } from "./const";
import { init } from "./init";
import { getAppVersion, getBundleId, reload } from "./native";

export type * from "./init";
export type * from "./checkForUpdate";
export type * from "./native";

export const HotUpdater = {
  init,
  reload,
  checkForUpdate,
  getAppVersion,
  getBundleId,
  /**
   * In production environment, this value will be replaced with a uuidv7.
   */
  HOT_UPDATER_BUNDLE_ID: NIL_UUID,
};
