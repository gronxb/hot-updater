import { getUpdateInfo } from "@hot-updater/js";
import { ensureUpdateInfo } from "./ensureUpdateInfo";
import {
  addListener,
  getAppVersion,
  getBundleId,
  reload,
  updateBundle,
} from "./native";
import { hotUpdaterStore } from "./store";
import { wrap } from "./wrap";

export type * from "./wrap";
export type * from "./native";

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

  ensureUpdateInfo,
  updateBundle,
  getUpdateInfo,
};
