import { checkForUpdate } from "./checkUpdate";
import {
  addListener,
  getAppVersion,
  getBundleId,
  reload,
  updateBundle,
} from "./native";
import { runUpdateProcess } from "./runUpdateProcess";
import { hotUpdaterStore } from "./store";
import { wrap } from "./wrap";

export type { HotUpdaterConfig } from "./wrap";
export type { HotUpdaterEvent } from "./native";

export * from "./store";

addListener("onProgress", ({ progress }) => {
  hotUpdaterStore.setProgress(progress);
});

export const HotUpdater = {
  wrap,

  reload,
  getAppVersion,
  getBundleId,
  addListener,

  checkForUpdate,
  runUpdateProcess,
  updateBundle,
};
