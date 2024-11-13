import { checkForUpdate } from "./checkForUpdate";
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
};
