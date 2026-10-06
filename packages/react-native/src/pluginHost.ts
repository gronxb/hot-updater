import { createPluginHost } from "@hot-updater/protocol";
import { Platform } from "react-native";

import {
  getAppVersion,
  getBundleId,
  getChannel,
  getCohort,
  getFingerprintHash,
  getInstallId,
  getMinBundleId,
  getStorageItem,
  setStorageItem,
} from "./native";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";

export type { PluginHostConfig } from "@hot-updater/protocol";

/** The app's plugin host: plugins read the native module and fetch the configured server. */
export const {
  configurePlugins,
  hasPluginHook,
  buildPluginEvent,
  dispatchPluginHook,
  emitPluginHook,
} = createPluginHost({
  fetch: (url, init) => fetch(url, init),
  get platform() {
    return Platform.OS === "android" ? "android" : "ios";
  },
  get isDebugBuild() {
    return typeof __DEV__ !== "undefined" && __DEV__;
  },
  get sdkVersion() {
    return HOT_UPDATER_SDK_VERSION;
  },
  getInstallId: () => getInstallId(),
  getAppVersion: () => getAppVersion(),
  getMinBundleId: () => getMinBundleId(),
  getBundleId: () => getBundleId(),
  getChannel: () => getChannel(),
  getCohort: () => getCohort(),
  getFingerprintHash: () => getFingerprintHash(),
  getStorageItem: (key) => getStorageItem(key),
  setStorageItem: (key, value) => setStorageItem(key, value),
  now: () => Date.now(),
});
