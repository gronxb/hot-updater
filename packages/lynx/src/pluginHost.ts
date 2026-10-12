import { createPluginHost } from "@hot-updater/protocol";

import { version } from "../package.json";
import { callNativeSync, LynxUpdaterError } from "./native";
import type { NativeState } from "./types";

export function createLynxPluginHost(readState: () => NativeState) {
  let info: { installId: string; isDebugBuild: boolean } | undefined;
  const pluginInfo = () => {
    if (!info) {
      const value = callNativeSync<{
        installId: string;
        isDebugBuild: boolean;
      }>("getPluginInfo");
      if (
        !value ||
        typeof value.installId !== "string" ||
        !value.installId ||
        typeof value.isDebugBuild !== "boolean"
      ) {
        throw new LynxUpdaterError(
          "INVALID_NATIVE_REPLY",
          "Native plugin information is invalid.",
        );
      }
      info = value;
    }
    return info;
  };
  return createPluginHost({
    fetch: (url, init) => fetch(url, init),
    get platform() {
      return readState().platform;
    },
    get isDebugBuild() {
      return pluginInfo().isDebugBuild;
    },
    sdkVersion: version,
    getInstallId: () => pluginInfo().installId,
    getAppVersion: () => readState().appVersion,
    getMinBundleId: () => readState().embeddedBundleId,
    getBundleId: () => readState().runningSelection.bundleId,
    getChannel: () => readState().channel,
    getCohort: () => readState().cohort,
    getFingerprintHash: () => readState().fingerprintHash ?? null,
    getStorageItem: (key) => {
      const value = callNativeSync<unknown>("getPluginStorageItem", key);
      if (value !== null && typeof value !== "string")
        throw new LynxUpdaterError(
          "INVALID_NATIVE_REPLY",
          "Native plugin storage value is invalid.",
        );
      return value;
    },
    setStorageItem: (key, value) => {
      if (callNativeSync<unknown>("setPluginStorageItem", key, value) !== true)
        throw new LynxUpdaterError(
          "INVALID_NATIVE_REPLY",
          "Native plugin storage write was not confirmed.",
        );
    },
    now: () => Date.now(),
  });
}
