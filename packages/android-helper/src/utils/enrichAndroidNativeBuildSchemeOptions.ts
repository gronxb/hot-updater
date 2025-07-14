import type { NativeBuildAndroidScheme } from "@hot-updater/plugin-core";
import type {
  AndroidDeviceData,
  EnrichedNativeBuildAndroidScheme,
} from "../types";

export const enrichAndroidNativeBuildSchemeOptions = (
  scheme: NativeBuildAndroidScheme,
  { device }: { device?: AndroidDeviceData },
): EnrichedNativeBuildAndroidScheme => {
  return {
    aab: true,
    variant: "Release",
    appModuleName: "app",
    ...scheme,
    device,
  };
};
