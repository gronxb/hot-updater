import {
  createPluginHost,
  type PluginHost,
  type PluginHostEnvironment,
} from "@hot-updater/protocol";
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

export type { PluginHost, PluginHostConfig } from "@hot-updater/protocol";

/** The native module and runtime every plugin host reads. */
const environment: PluginHostEnvironment = {
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
};

/**
 * Creates an instance's plugin host: its plugins read the native module and
 * fetch the server the instance was configured with.
 */
export const createAppPluginHost = (): PluginHost =>
  createPluginHost(environment);
