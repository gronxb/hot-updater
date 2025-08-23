import type { NativeBuildAndroidScheme } from "@hot-updater/plugin-core";
import type { AndroidDevice } from "../types";
import { selectAndroidTargetDevice } from "./selectAndroidTargetDevice";

/**
 * Validated android scheme filled nullish values with default values.
 */
export type EnrichedNativeBuildAndroidScheme =
  Required<NativeBuildAndroidScheme> & {
    device?: AndroidDevice;
  };
export const enrichAndroidNativeBuildSchemeOptions = async ({
  schemeConfig,
  selectDevice,
  deviceOption,
  interactive = false,
}: {
  schemeConfig: NativeBuildAndroidScheme;
  selectDevice: boolean;
  interactive?: boolean;
  deviceOption?: string | boolean;
}): Promise<EnrichedNativeBuildAndroidScheme> => {
  const androidDevice = !selectDevice
    ? undefined
    : (await selectAndroidTargetDevice({ deviceOption, interactive })).device;

  return {
    aab: true,
    variant: "Release",
    appModuleName: "app",
    ...schemeConfig,
    device: androidDevice,
  };
};
