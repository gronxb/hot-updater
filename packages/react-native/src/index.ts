import { checkForUpdate } from "./checkForUpdate";
import { NIL_UUID } from "./const";
import { init } from "./init";
import { addListener, getAppVersion, getBundleId, reload } from "./native";
import { hotUpdaterStore } from "./store";

export type * from "./init";
export type * from "./checkForUpdate";
export type * from "./native";

export * from "./store";

addListener("onProgress", ({ progress }) => {
  hotUpdaterStore.setState({ progress });
});

export const HotUpdater = {
  init,
  reload,
  checkForUpdate,
  getAppVersion,
  getBundleId,
  addListener,
  /**
   * In production environment, this value will be replaced with a uuidv7.
   */
  HOT_UPDATER_BUNDLE_ID: NIL_UUID,
};
