import { getUpdateInfo } from "@hot-updater/js";
import { ensureBundles } from "./ensureBundles";
import { init } from "./init";
import {
  addListener,
  getAppVersion,
  getBundleId,
  reload,
  updateBundle,
} from "./native";
import { hotUpdaterStore } from "./store";

export type * from "./init";
export type * from "./native";

export * from "./store";

addListener("onProgress", ({ progress }) => {
  hotUpdaterStore.setState({ progress });
});

export const HotUpdater = {
  init,
  reload,
  getAppVersion,
  getBundleId,
  addListener,

  ensureBundles,
  updateBundle,
  getUpdateInfo,
};
